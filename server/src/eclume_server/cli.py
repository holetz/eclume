"""CLI `eclume-server`: migrations, contas de admin do painel, o anúncio mDNS, o armazenamento e a CA raiz."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

from eclume_engines.registro import configurar_logs
from eclume_server.config import get_settings

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncEngine

    from eclume_server.storage import Storage

LEGACY_PREFIX = "orgs/"
# Token de longa duração do `claude setup-token`: vale um ano a partir do cadastro.
OAUTH_TOKEN_PREFIX = "sk-ant-oat"  # noqa: S105 — prefixo do formato, não um segredo
TOKEN_LIFETIME = timedelta(days=365)
# Job na fila da GPU há mais que isso sem começar vira alerta do vigia.sh.
STALE_QUEUED = timedelta(hours=2)


def _password(from_stdin: bool) -> str:  # noqa: FBT001 — espelha a flag do CLI
    if from_stdin:
        return sys.stdin.readline().rstrip("\n")
    return getpass.getpass("Senha: ")


async def _migrate() -> None:
    from eclume_server.db.migrate import RUNTIME_ROLE, enable_runtime_login, migrate  # noqa: PLC0415
    from eclume_server.db.session import make_engine  # noqa: PLC0415

    settings = get_settings()
    engine = make_engine(settings.database_url)
    try:
        applied = await migrate(engine)
        if settings.runtime_db_password:
            await enable_runtime_login(engine, settings.runtime_db_password)
    finally:
        await engine.dispose()
    print("aplicadas: " + (", ".join(applied) if applied else "nenhuma (schema em dia)"))  # noqa: T201
    if settings.runtime_db_password:
        print(f"papel {RUNTIME_ROLE} com LOGIN")  # noqa: T201


async def _pending() -> None:
    from eclume_server.db.migrate import pending  # noqa: PLC0415
    from eclume_server.db.session import make_engine  # noqa: PLC0415

    engine = make_engine(get_settings().database_url)
    try:
        versions = await pending(engine)
    finally:
        await engine.dispose()
    for version in versions:
        print(version)  # noqa: T201


async def _create_admin(args: argparse.Namespace, password: str) -> None:
    from eclume_server.accounts import create_admin  # noqa: PLC0415
    from eclume_server.db.migrate import migrate  # noqa: PLC0415
    from eclume_server.db.session import make_engine, system_tx  # noqa: PLC0415

    engine = make_engine(get_settings().database_url)
    try:
        await migrate(engine)
        async with system_tx(engine) as conn:
            admin_id = await create_admin(conn, email=args.email, name=args.name, password=password)
    finally:
        await engine.dispose()
    print(f"admin {admin_id}")  # noqa: T201


async def _set_admin_password(args: argparse.Namespace, password: str) -> None:
    from eclume_server.accounts import set_admin_password  # noqa: PLC0415
    from eclume_server.db.session import make_engine, system_tx  # noqa: PLC0415

    engine = make_engine(get_settings().database_url)
    try:
        async with system_tx(engine) as conn:
            admin_id = await set_admin_password(conn, email=args.email, password=password)
    finally:
        await engine.dispose()
    print(f"senha do admin {admin_id} trocada; sessões encerradas")  # noqa: T201


async def relocate_legacy(engine: AsyncEngine, storage: Storage, *, dry_run: bool) -> list[str]:
    """Move os áudios das chaves `orgs/…` (época da organização) para `users/{dono}/recordings/{id}/audio`.

    Idempotente: copia (pulando a cópia se o destino já existe com o mesmo tamanho), troca
    `recordings.audio_key` e põe a chave antiga na fila de exclusão do bucket na mesma transação.
    Pula a gravação com job `queued`/`running`: o `transcribe` na fila carrega a chave antiga.
    Devolve uma linha por gravação, para o relatório.
    """
    from sqlalchemy import exists, insert, select, update  # noqa: PLC0415

    from eclume_server.db import tables as t  # noqa: PLC0415
    from eclume_server.db.session import system_tx  # noqa: PLC0415
    from eclume_server.storage import audio_key  # noqa: PLC0415

    r, jobs = t.recordings.c, t.transcription_jobs.c
    open_job = exists().where(jobs.recording_id == r.id, jobs.state.in_(["queued", "running"]))
    async with system_tx(engine) as conn:
        rows = (
            await conn.execute(
                select(r.id, r.owner_id, r.audio_key, open_job.label("busy"))
                .where(r.audio_key.startswith(LEGACY_PREFIX))
                .order_by(r.created_at)
            )
        ).all()
    lines = []
    for recording_id, owner_id, old, busy in rows:
        target = audio_key(owner_id, recording_id)
        if busy:
            lines.append(f"pulada {recording_id}: transcrição em andamento")
            continue
        if dry_run:
            lines.append(f"moveria {old} → {target}")
            continue
        size = await storage.object_size(old)
        if size is None:
            lines.append(f"pulada {recording_id}: {old} não existe no bucket")
            continue
        if await storage.object_size(target) != size:
            await storage.copy_object(old, target)
        async with system_tx(engine) as conn:
            moved = await conn.execute(
                update(t.recordings).where(r.id == recording_id, r.audio_key == old).values(audio_key=target)
            )
            if moved.rowcount:
                await conn.execute(insert(t.storage_deletions).values(key=old))
        lines.append(f"movida {old} → {target}")
    return lines


async def _relocate(dry_run: bool) -> None:  # noqa: FBT001 — espelha a flag do CLI
    from eclume_server.db.session import make_engine  # noqa: PLC0415
    from eclume_server.storage import Storage  # noqa: PLC0415

    settings = get_settings()
    engine = make_engine(settings.database_url)
    try:
        lines = await relocate_legacy(engine, Storage(settings), dry_run=dry_run)
    finally:
        await engine.dispose()
    for line in lines:
        print(line)  # noqa: T201
    print(f"{len(lines)} gravações com chave {LEGACY_PREFIX}" if lines else f"nenhuma chave {LEGACY_PREFIX} a mover")  # noqa: T201


def _discover(timeout: float) -> int:
    from eclume_server.discovery import discover  # noqa: PLC0415

    servers = asyncio.run(discover(timeout))
    for server in servers:
        print(json.dumps(server, ensure_ascii=False))  # noqa: T201
    if not servers:
        print("nenhum servidor eclume encontrado", file=sys.stderr)  # noqa: T201
        return 1
    return 0


def token_validity(providers: list[dict[str, Any]], now: datetime) -> dict[str, Any]:
    """Vencimento do token de longa duração do Claude cadastrado no painel.

    O `sk-ant-oat…` é opaco: vence `TOKEN_LIFETIME` depois de `key_set_at`. Sem provider com esse
    token, o do ambiente (`ECLUME_CLAUDE_OAUTH_TOKEN`) não tem data: `status` `unknown`.
    """
    dated = [p for p in providers if p["key"].startswith(OAUTH_TOKEN_PREFIX) and p["key_set_at"] is not None]
    if not dated:
        return {"status": "unknown", "expires_at": None, "days_left": None}
    first = min(dated, key=lambda p: p["key_set_at"])
    expires = first["key_set_at"] + TOKEN_LIFETIME
    return {
        "status": "ok",
        "provider": first["name"],
        "expires_at": expires.isoformat(),
        "days_left": (expires - now).days,
    }


async def _health_report() -> dict[str, Any]:
    """`saude --json`: os números da Saúde do admin, um resumo para o `vigia.sh` e o token do Claude."""
    from sqlalchemy import select  # noqa: PLC0415

    from eclume_server.agents.base import PROVIDER_AUTH  # noqa: PLC0415
    from eclume_server.context import AppContext  # noqa: PLC0415
    from eclume_server.crypto import decrypt  # noqa: PLC0415
    from eclume_server.db import tables as t  # noqa: PLC0415
    from eclume_server.db.session import make_engine, system_tx  # noqa: PLC0415
    from eclume_server.health import admin_health  # noqa: PLC0415
    from eclume_server.queue import Queue  # noqa: PLC0415
    from eclume_server.storage import Storage  # noqa: PLC0415

    settings = get_settings()
    engine = make_engine(settings.database_url)
    queue = await Queue.connect(settings.redis_url)
    try:
        ctx = AppContext(settings=settings, engine=engine, storage=Storage(settings), queue=queue)
        health = await admin_health(ctx)
        async with system_tx(engine) as conn:
            rows = (
                await conn.execute(
                    select(
                        t.agent_providers.c.name, t.agent_providers.c.api_key_encrypted, t.agent_providers.c.key_set_at
                    ).where(t.agent_providers.c.enabled, t.agent_providers.c.api_key_encrypted.is_not(None))
                )
            ).all()
    finally:
        await queue.close()
        await engine.dispose()
    providers = [
        {"name": row.name, "key": decrypt(settings, row.api_key_encrypted), "key_set_at": row.key_set_at}
        for row in rows
    ]
    now = datetime.now(UTC)
    stale = now - STALE_QUEUED
    queued_too_long = [
        job
        for job in health["running_jobs"]
        if job["state"] == "queued" and datetime.fromisoformat(job["queued_at"]) < stale
    ]
    return {
        "checked_at": health["checked_at"],
        "summary": {
            "queued_over_2h": len(queued_too_long),
            "failed_last_24h": len(health["recent_failures"]),
            "provider_auth_last_24h": sum(1 for f in health["recent_failures"] if f["code"] == PROVIDER_AUTH),
            "services_down": [s["name"] for s in health["services"] if s["status"] == "down"],
        },
        "claude_token": token_validity(providers, now),
        "health": health,
    }


def _ca_generate(args: argparse.Namespace) -> None:
    from eclume_server.ca import generate, generate_proof, sha256, split_names  # noqa: PLC0415

    if args.prova:
        root = generate_proof(Path(args.prova))
        print(f"prova em {args.prova}: raiz.crt, dentro.crt/key (127.0.0.1), fora.crt/key (127.0.0.2)")  # noqa: T201
    else:
        root = generate(Path(args.pasta), args.host or "", split_names(args.nomes))
    print(f"sha256 {sha256(root)}")  # noqa: T201


def build_parser() -> argparse.ArgumentParser:
    """Parser do CLI."""
    parser = argparse.ArgumentParser(prog="eclume-server", description="Administração do server do eclume.")
    commands = parser.add_subparsers(dest="command", required=True)
    migrate_cmd = commands.add_parser(
        "migrate", help="aplica as migrations pendentes (e liga o papel eclume_server com ECLUME_RUNTIME_DB_PASSWORD)"
    )
    migrate_cmd.add_argument(
        "--pendentes", action="store_true", help="só lista as migrations pendentes, uma por linha, sem aplicar"
    )

    commands.add_parser("announce", help="anuncia o servidor na rede local (mDNS _eclume._tcp) até ser interrompido")
    found = commands.add_parser("discover", help="procura servidores eclume na rede local e imprime um JSON por linha")
    found.add_argument("--timeout", type=float, default=5.0, help="segundos de escuta (padrão 5)")

    storage = commands.add_parser("storage", help="armazenamento de objetos").add_subparsers(
        dest="storage", required=True
    )
    relocate = storage.add_parser(
        "relocate-legacy", help="move os áudios das chaves orgs/… para users/{dono}/recordings/{id}/audio"
    )
    relocate.add_argument("--dry-run", action="store_true", help="só lista o que moveria")

    report = commands.add_parser("saude", help="a Saúde do admin e o vencimento do token do Claude, para o vigia.sh")
    report.add_argument("--json", action="store_true", required=True, help="imprime um objeto JSON")

    probe = commands.add_parser("sonda", help="sondas do healthcheck dos contêineres").add_subparsers(
        dest="sonda", required=True
    )
    probe_queue = probe.add_parser("fila", help="sai 0 se o worker arq da fila renovou o health-check (16 s)")
    probe_queue.add_argument("nome", nargs="+", help="filas sem o prefixo eclume: (default, agents)")

    ca = commands.add_parser("ca", help="CA raiz própria do eclume").add_subparsers(dest="ca", required=True)
    ca_generate = ca.add_parser(
        "gerar", help="cria a raiz com restrição de nome (raiz.crt, raiz.key) e recusa sobrescrever"
    )
    target = ca_generate.add_mutually_exclusive_group(required=True)
    target.add_argument("--pasta", help="destino da raiz (em produção, <ECLUME_DATA_DIR>/secrets/ca)")
    target.add_argument("--prova", help="pasta da raiz descartável de 127.0.0.1 e dos folhas dentro e fora")
    ca_generate.add_argument(
        "--host", default=os.environ.get("ECLUME_PUBLIC_HOST"), help="IP ou nome permitido (ECLUME_PUBLIC_HOST)"
    )
    ca_generate.add_argument(
        "--nomes",
        default=os.environ.get("ECLUME_CA_NOMES"),
        help="outros IPs ou nomes DNS permitidos, por vírgula ou espaço (ECLUME_CA_NOMES)",
    )

    admin = commands.add_parser("admin", help="contas de admin do painel").add_subparsers(dest="admin", required=True)
    create = admin.add_parser("create", help="cria uma conta de admin (aplica as migrations)")
    create.add_argument("--email", required=True)
    create.add_argument("--name", required=True)
    password = admin.add_parser("set-password", help="troca a senha de um admin e encerra as sessões dele")
    password.add_argument("--email", required=True)
    for sub in (create, password):
        sub.add_argument("--password-stdin", action="store_true", help="lê a senha da primeira linha do stdin")
    return parser


def _erros_de_negocio() -> tuple[type[Exception], ...]:
    """Os erros que o CLI mostra como `erro: …` (código 2); importados só quando um comando falhou."""
    from eclume_server.accounts import AccountError  # noqa: PLC0415
    from eclume_server.ca import CaError  # noqa: PLC0415
    from eclume_server.discovery import DiscoveryError  # noqa: PLC0415

    return (AccountError, CaError, DiscoveryError)


def main(argv: list[str] | None = None) -> int:
    """Ponto de entrada do script `eclume-server`."""
    args = build_parser().parse_args(argv)
    # O stdout é dos dados (`saude --json`, `discover`); o log do CLI vai para o stderr.
    configurar_logs(stream=sys.stderr)
    try:
        if args.command == "migrate":
            asyncio.run(_pending() if args.pendentes else _migrate())
        elif args.command == "announce":
            from eclume_server.discovery import announce  # noqa: PLC0415

            asyncio.run(announce(get_settings()))
        elif args.command == "discover":
            return _discover(args.timeout)
        elif args.command == "saude":
            print(json.dumps(asyncio.run(_health_report()), ensure_ascii=False))  # noqa: T201
        elif args.command == "sonda":
            from eclume_server.sonda import main as sonda  # noqa: PLC0415

            return sonda(["fila", *args.nome])
        elif args.command == "storage":
            asyncio.run(_relocate(args.dry_run))
        elif args.command == "ca":
            _ca_generate(args)
        elif args.admin == "create":
            asyncio.run(_create_admin(args, _password(args.password_stdin)))
        else:
            asyncio.run(_set_admin_password(args, _password(args.password_stdin)))
    except _erros_de_negocio() as exc:
        print(f"erro: {exc}", file=sys.stderr)  # noqa: T201
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
