"""The `eclume-server` CLI: migrations, admin panel accounts, the mDNS announcement, storage and the root CA."""

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
# Long-lived token from `claude setup-token`: valid for one year from registration.
OAUTH_TOKEN_PREFIX = "sk-ant-oat"  # noqa: S105 — the format prefix, not a secret
TOKEN_LIFETIME = timedelta(days=365)
# A job queued on the GPU longer than this without starting becomes a vigia.sh alert.
STALE_QUEUED = timedelta(hours=2)


def _password(from_stdin: bool) -> str:  # noqa: FBT001 — mirrors the CLI flag
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
    """Move the audio under `orgs/…` keys (organization era) to `users/{owner}/recordings/{id}/audio`.

    Idempotent: copies (skipping the copy when the target already exists with the same size), swaps
    `recordings.audio_key` and puts the old key on the bucket deletion queue in the same transaction.
    Skips a recording with a `queued`/`running` job: the queued `transcribe` carries the old key.
    Returns one line per recording, for the report.
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


async def _relocate(dry_run: bool) -> None:  # noqa: FBT001 — mirrors the CLI flag
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
    """Expiry of the long-lived Claude token registered in the panel.

    The `sk-ant-oat…` token is opaque: it expires `TOKEN_LIFETIME` after `key_set_at`. With no
    provider holding such a token, the one from the environment (`ECLUME_CLAUDE_OAUTH_TOKEN`) has no
    date: `status` `unknown`.
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
    """`saude --json`: the admin Health numbers, a summary for `vigia.sh` and the Claude token."""
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
    """The CLI parser."""
    parser = argparse.ArgumentParser(prog="eclume-server", description="Administration of the eclume server.")
    commands = parser.add_subparsers(dest="command", required=True)
    migrate_cmd = commands.add_parser(
        "migrate",
        help="applies the pending migrations (and enables the eclume_server role with ECLUME_RUNTIME_DB_PASSWORD)",
    )
    migrate_cmd.add_argument(
        "--pendentes",
        action="store_true",
        help="only lists the pending migrations, one per line, without applying them",
    )

    commands.add_parser(
        "worker", help="runs the CPU workers of the eclume:default and eclume:agents queues in a single process"
    )
    commands.add_parser(
        "announce", help="announces the server on the local network (mDNS _eclume._tcp) until interrupted"
    )
    found = commands.add_parser(
        "discover", help="looks for eclume servers on the local network and prints one JSON per line"
    )
    found.add_argument("--timeout", type=float, default=5.0, help="seconds to listen (default 5)")

    storage = commands.add_parser("storage", help="object storage").add_subparsers(dest="storage", required=True)
    relocate = storage.add_parser(
        "relocate-legacy", help="moves the audio under orgs/… keys to users/{owner}/recordings/{id}/audio"
    )
    relocate.add_argument("--dry-run", action="store_true", help="only lists what it would move")

    report = commands.add_parser("saude", help="the admin Health and the Claude token expiry, for vigia.sh")
    report.add_argument("--json", action="store_true", required=True, help="prints a JSON object")

    probe = commands.add_parser("sonda", help="container healthcheck probes").add_subparsers(
        dest="probe", required=True
    )
    probe_queue = probe.add_parser("fila", help="exits 0 if the queue's arq worker renewed its health-check (16 s)")
    probe_queue.add_argument("names", nargs="+", help="queues without the eclume: prefix (default, agents)")

    ca = commands.add_parser("ca", help="eclume's own root CA").add_subparsers(dest="ca", required=True)
    ca_generate = ca.add_parser(
        "gerar", help="creates the name-constrained root (raiz.crt, raiz.key) and refuses to overwrite"
    )
    target = ca_generate.add_mutually_exclusive_group(required=True)
    target.add_argument("--pasta", help="root destination (in production, <ECLUME_DATA_DIR>/secrets/ca)")
    target.add_argument("--prova", help="folder for the disposable 127.0.0.1 root and the inside and outside leaves")
    ca_generate.add_argument(
        "--host", default=os.environ.get("ECLUME_PUBLIC_HOST"), help="permitted IP or name (ECLUME_PUBLIC_HOST)"
    )
    ca_generate.add_argument(
        "--nomes",
        default=os.environ.get("ECLUME_CA_NOMES"),
        help="other permitted IPs or DNS names, comma- or space-separated (ECLUME_CA_NOMES)",
    )

    admin = commands.add_parser("admin", help="admin panel accounts").add_subparsers(dest="admin", required=True)
    create = admin.add_parser("create", help="creates an admin account (applies the migrations)")
    create.add_argument("--email", required=True)
    create.add_argument("--name", required=True)
    password = admin.add_parser("set-password", help="changes an admin's password and ends their sessions")
    password.add_argument("--email", required=True)
    for sub in (create, password):
        sub.add_argument(
            "--password-stdin", action="store_true", help="reads the password from the first line of stdin"
        )
    return parser


def _worker() -> None:
    from eclume_server.worker import main as worker_main  # noqa: PLC0415

    worker_main()


def _announce() -> None:
    from eclume_server.discovery import announce  # noqa: PLC0415

    asyncio.run(announce(get_settings()))


# Commands that run until interrupted and take no argument.
LONG_RUNNING = {"worker": _worker, "announce": _announce}


def _probe(queues: list[str]) -> int:
    from eclume_server.sonda import main as probe  # noqa: PLC0415

    return probe(["fila", *queues])


def _business_errors() -> tuple[type[Exception], ...]:
    """The errors the CLI shows as `erro: …` (exit code 2); imported only when a command failed."""
    from eclume_server.accounts import AccountError  # noqa: PLC0415
    from eclume_server.ca import CaError  # noqa: PLC0415
    from eclume_server.discovery import DiscoveryError  # noqa: PLC0415

    return (AccountError, CaError, DiscoveryError)


def main(argv: list[str] | None = None) -> int:
    """Entry point of the `eclume-server` script."""
    args = build_parser().parse_args(argv)
    # stdout carries the data (`saude --json`, `discover`); the CLI log goes to stderr.
    configurar_logs(stream=sys.stderr)
    try:
        if args.command == "migrate":
            asyncio.run(_pending() if args.pendentes else _migrate())
        elif args.command in LONG_RUNNING:
            LONG_RUNNING[args.command]()
        elif args.command == "discover":
            return _discover(args.timeout)
        elif args.command == "saude":
            print(json.dumps(asyncio.run(_health_report()), ensure_ascii=False))  # noqa: T201
        elif args.command == "sonda":
            return _probe(args.names)
        elif args.command == "storage":
            asyncio.run(_relocate(args.dry_run))
        elif args.command == "ca":
            _ca_generate(args)
        elif args.admin == "create":
            asyncio.run(_create_admin(args, _password(args.password_stdin)))
        else:
            asyncio.run(_set_admin_password(args, _password(args.password_stdin)))
    except _business_errors() as exc:
        print(f"erro: {exc}", file=sys.stderr)  # noqa: T201
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
