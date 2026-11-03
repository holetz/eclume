from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

import eclume_engines
import eclume_server
from eclume_server.db.migrate import migrate, migration_files
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from eclume_server_testing.harness import Services


def test_package_imports_and_sees_the_engine_interface():
    # The three Python parts are the "product" line and move together (deploy/versao.py).
    assert eclume_server.__version__ == eclume_engines.__version__


def test_applied_migrations_force_rls_and_are_idempotent(services: Services):
    async def check(conn):  # noqa: ANN001, ANN202
        versions = (await conn.execute(text("SELECT version FROM schema_migrations ORDER BY 1"))).scalars().all()
        forced = (
            (
                await conn.execute(
                    text(
                        "SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace"
                        " AND relrowsecurity AND relforcerowsecurity"
                    )
                )
            )
            .scalars()
            .all()
        )
        role = (
            await conn.execute(text("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'eclume_app'"))
        ).one()
        return versions, forced, tuple(role)

    versions, forced, role = run(services.sql(check))
    assert versions == [path.stem for path in migration_files()]
    # Every content and user-account table is under forced RLS; the platform ones are not.
    content = {"recordings", "transcripts", "segments", "uploads", "api_tokens", "people", "summaries", "users"}
    assert content <= set(forced)
    assert not {"platform_settings", "platform_secrets", "agent_providers", "admins", "sessions"} & set(forced)
    assert role == (False, False)

    async def again() -> list[str]:
        engine = create_async_engine(services.settings.database_url)
        try:
            return await migrate(engine)
        finally:
            await engine.dispose()

    assert run(again()) == []
