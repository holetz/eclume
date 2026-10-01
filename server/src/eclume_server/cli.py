"""CLI `eclume-server`: migrations, contas de admin do painel, o anúncio mDNS e o armazenamento."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import sys
from typing import TYPE_CHECKING

from sqlalchemy import exists, insert, select, update

from eclume_server.accounts import AccountError, create_admin, set_admin_password
from eclume_server.config import get_settings
from eclume_server.db import tables as t
from eclume_server.db.migrate import RUNTIME_ROLE, enable_runtime_login, migrate, pending
from eclume_server.db.session import make_engine, system_tx
from eclume_server.discovery import DiscoveryError, announce, discover
from eclume_server.storage import Storage, audio_key

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncEngine

LEGACY_PREFIX = "orgs/"


def _password(from_stdin: bool) -> str:  # noqa: FBT001 — espelha a flag do CLI
    if from_stdin:
        return sys.stdin.readline().rstrip("\n")
    return getpass.getpass("Senha: ")


async def _migrate() -> None:
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
    engine = make_engine(get_settings().database_url)
    try:
        versions = await pending(engine)
    finally:
        await engine.dispose()
    for version in versions:
        print(version)  # noqa: T201


async def _create_admin(args: argparse.Namespace, password: str) -> None:
    engine = make_engine(get_settings().database_url)
    try:
        await migrate(engine)
        async with system_tx(engine) as conn:
            admin_id = await create_admin(conn, email=args.email, name=args.name, password=password)
    finally:
        await engine.dispose()
    print(f"admin {admin_id}")  # noqa: T201


async def _set_admin_password(args: argparse.Namespace, password: str) -> None:
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
    servers = asyncio.run(discover(timeout))
    for server in servers:
        print(json.dumps(server, ensure_ascii=False))  # noqa: T201
    if not servers:
        print("nenhum servidor eclume encontrado", file=sys.stderr)  # noqa: T201
        return 1
    return 0


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

    admin = commands.add_parser("admin", help="contas de admin do painel").add_subparsers(dest="admin", required=True)
    create = admin.add_parser("create", help="cria uma conta de admin (aplica as migrations)")
    create.add_argument("--email", required=True)
    create.add_argument("--name", required=True)
    password = admin.add_parser("set-password", help="troca a senha de um admin e encerra as sessões dele")
    password.add_argument("--email", required=True)
    for sub in (create, password):
        sub.add_argument("--password-stdin", action="store_true", help="lê a senha da primeira linha do stdin")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Ponto de entrada do script `eclume-server`."""
    args = build_parser().parse_args(argv)
    try:
        if args.command == "migrate":
            asyncio.run(_pending() if args.pendentes else _migrate())
        elif args.command == "announce":
            asyncio.run(announce(get_settings()))
        elif args.command == "discover":
            return _discover(args.timeout)
        elif args.command == "storage":
            asyncio.run(_relocate(args.dry_run))
        elif args.admin == "create":
            asyncio.run(_create_admin(args, _password(args.password_stdin)))
        else:
            asyncio.run(_set_admin_password(args, _password(args.password_stdin)))
    except (AccountError, DiscoveryError) as exc:
        print(f"erro: {exc}", file=sys.stderr)  # noqa: T201
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
