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


def test_pacote_importa_e_enxerga_a_interface_de_engine():
    assert eclume_server.__version__ == "0.1.0"
    assert eclume_engines.__version__ == "0.1.0"


def test_migrations_aplicadas_forcam_rls_e_sao_idempotentes(services: Services):
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
    # Toda tabela de conteúdo e de conta de usuário está sob RLS forçada; as da plataforma, não.
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
