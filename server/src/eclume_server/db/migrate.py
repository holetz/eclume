"""Runner das migrations SQL versionadas (`migrations/NNN_nome.sql`)."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy import text

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncEngine

MIGRATIONS = Path(__file__).with_name("migrations")
# Chave arbitrária do advisory lock: dois processos subindo juntos não aplicam a mesma migration.
_LOCK_KEY = 0x0EC1_0E00


def migration_files() -> list[Path]:
    """Migrations em ordem de versão."""
    return sorted(MIGRATIONS.glob("[0-9][0-9][0-9]_*.sql"))


async def migrate(engine: AsyncEngine) -> list[str]:
    """Aplica, cada uma na sua transação, as migrations ainda não aplicadas; devolve as aplicadas."""
    applied_now: list[str] = []
    async with engine.connect() as conn:
        await conn.execute(text("SELECT pg_advisory_lock(:key)"), {"key": _LOCK_KEY})
        try:
            # Só cria quando falta: o papel de conexão da aplicação (`eclume_server`) não tem
            # CREATE no schema e roda `migrate` no `admin bootstrap` com o schema já em dia.
            if (await conn.execute(text("SELECT to_regclass('schema_migrations')"))).scalar() is None:
                await conn.execute(
                    text(
                        "CREATE TABLE schema_migrations ("
                        " version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
                    )
                )
            await conn.commit()
            done = set((await conn.execute(text("SELECT version FROM schema_migrations"))).scalars())
            await conn.commit()
            for path in migration_files():
                version = path.stem
                if version in done:
                    continue
                # SQL com vários comandos e blocos `DO $$`: vai pelo protocolo simples do asyncpg.
                raw = (await conn.get_raw_connection()).driver_connection
                async with raw.transaction():
                    await raw.execute(path.read_text(encoding="utf-8"))
                    await raw.execute("INSERT INTO schema_migrations (version) VALUES ($1)", version)
                applied_now.append(version)
        finally:
            await conn.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": _LOCK_KEY})
            await conn.commit()
    return applied_now


RUNTIME_ROLE = "eclume_server"


async def enable_runtime_login(engine: AsyncEngine, password: str) -> None:
    """Liga o LOGIN do papel de conexão da aplicação (criado pela migration 006) com esta senha."""
    async with engine.begin() as conn:
        # `ALTER ROLE` não aceita parâmetro: o literal sai do `format(%L)` do próprio Postgres.
        statement = (
            await conn.execute(
                text("SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', CAST(:role AS text), CAST(:password AS text))"),
                {"role": RUNTIME_ROLE, "password": password},
            )
        ).scalar_one()
        await conn.execute(text(statement))
