"""Runner of the versioned SQL migrations (`migrations/NNN_name.sql`)."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy import text

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncEngine

MIGRATIONS = Path(__file__).with_name("migrations")
# Arbitrary advisory-lock key: two processes starting together do not apply the same migration.
_LOCK_KEY = 0x0EC1_0E00


def migration_files() -> list[Path]:
    """Migrations in version order."""
    return sorted(MIGRATIONS.glob("[0-9][0-9][0-9]_*.sql"))


async def pending(engine: AsyncEngine) -> list[str]:
    """The versions of this tree's migrations the database has not applied yet, in order; applies nothing."""
    async with engine.connect() as conn:
        if (await conn.execute(text("SELECT to_regclass('schema_migrations')"))).scalar() is None:
            done: set[str] = set()
        else:
            done = set((await conn.execute(text("SELECT version FROM schema_migrations"))).scalars())
    return [path.stem for path in migration_files() if path.stem not in done]


async def migrate(engine: AsyncEngine, until: str | None = None) -> list[str]:
    """Apply, each in its own transaction, the migrations not yet applied; return the ones applied.

    With `until` (the version, such as `007_purga_de_embeddings`), stop at it: a migration's tests
    seed the database in the previous one's shape.
    """
    applied_now: list[str] = []
    async with engine.connect() as conn:
        await conn.execute(text("SELECT pg_advisory_lock(:key)"), {"key": _LOCK_KEY})
        try:
            # Create only when missing: the application's connection role (`eclume_server`) has no
            # CREATE on the schema and runs `migrate` in `admin bootstrap` with the schema already up to date.
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
                if until is not None and version > until:
                    break
                if version in done:
                    continue
                # SQL with several statements and `DO $$` blocks: goes through asyncpg's simple protocol.
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
    """Enable LOGIN for the application's connection role (created by migration 006) with this password."""
    async with engine.begin() as conn:
        # `ALTER ROLE` takes no parameter: the literal comes from Postgres's own `format(%L)`.
        statement = (
            await conn.execute(
                text("SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', CAST(:role AS text), CAST(:password AS text))"),
                {"role": RUNTIME_ROLE, "password": password},
            )
        ).scalar_one()
        await conn.execute(text(statement))
