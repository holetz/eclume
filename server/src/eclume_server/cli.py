"""CLI `eclume-server`: migrations e bootstrap da primeira organização e do admin."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import sys
from uuid import UUID

from eclume_server.accounts import AccountError, create_org, create_user
from eclume_server.config import get_settings
from eclume_server.db.migrate import RUNTIME_ROLE, enable_runtime_login, migrate
from eclume_server.db.session import make_engine, system_tx


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


async def _bootstrap(args: argparse.Namespace, password: str) -> None:
    engine = make_engine(get_settings().database_url)
    try:
        await migrate(engine)
        async with system_tx(engine) as conn:
            org_id = await create_org(conn, args.org)
            user_id = await create_user(conn, org_id, email=args.email, name=args.name, password=password, role="admin")
    finally:
        await engine.dispose()
    print(f"organização {org_id}\nadmin {user_id}")  # noqa: T201


async def _create_user(args: argparse.Namespace, password: str) -> None:
    engine = make_engine(get_settings().database_url)
    try:
        async with system_tx(engine) as conn:
            user_id = await create_user(
                conn, args.org_id, email=args.email, name=args.name, password=password, role=args.role
            )
    finally:
        await engine.dispose()
    print(f"usuário {user_id}")  # noqa: T201


def build_parser() -> argparse.ArgumentParser:
    """Parser do CLI."""
    parser = argparse.ArgumentParser(prog="eclume-server", description="Administração do server do eclume.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser(
        "migrate", help="aplica as migrations pendentes (e liga o papel eclume_server com ECLUME_RUNTIME_DB_PASSWORD)"
    )

    admin = commands.add_parser("admin", help="organizações e usuários").add_subparsers(dest="admin", required=True)
    bootstrap = admin.add_parser("bootstrap", help="cria a primeira organização e o seu admin (aplica as migrations)")
    bootstrap.add_argument("--org", required=True, help="nome da organização")
    create = admin.add_parser("create-user", help="cria um usuário numa organização existente")
    create.add_argument("--org-id", required=True, type=UUID)
    create.add_argument("--role", choices=["admin", "member"], default="member")
    for sub in (bootstrap, create):
        sub.add_argument("--email", required=True)
        sub.add_argument("--name", required=True)
        sub.add_argument("--password-stdin", action="store_true", help="lê a senha da primeira linha do stdin")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Ponto de entrada do script `eclume-server`."""
    args = build_parser().parse_args(argv)
    try:
        if args.command == "migrate":
            asyncio.run(_migrate())
        elif args.admin == "bootstrap":
            asyncio.run(_bootstrap(args, _password(args.password_stdin)))
        else:
            asyncio.run(_create_user(args, _password(args.password_stdin)))
    except AccountError as exc:
        print(f"erro: {exc}", file=sys.stderr)  # noqa: T201
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
