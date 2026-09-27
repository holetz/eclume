"""CLI `eclume-server`: migrations, contas de admin do painel e o anúncio mDNS."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import sys

from eclume_server.accounts import AccountError, create_admin, set_admin_password
from eclume_server.config import get_settings
from eclume_server.db.migrate import RUNTIME_ROLE, enable_runtime_login, migrate
from eclume_server.db.session import make_engine, system_tx
from eclume_server.discovery import DiscoveryError, announce, discover


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
    commands.add_parser(
        "migrate", help="aplica as migrations pendentes (e liga o papel eclume_server com ECLUME_RUNTIME_DB_PASSWORD)"
    )

    commands.add_parser("announce", help="anuncia o servidor na rede local (mDNS _eclume._tcp) até ser interrompido")
    found = commands.add_parser("discover", help="procura servidores eclume na rede local e imprime um JSON por linha")
    found.add_argument("--timeout", type=float, default=5.0, help="segundos de escuta (padrão 5)")

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
            asyncio.run(_migrate())
        elif args.command == "announce":
            asyncio.run(announce(get_settings()))
        elif args.command == "discover":
            return _discover(args.timeout)
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
