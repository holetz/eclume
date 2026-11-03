"""Per-process connection pool (`ECLUME_DB_POOL_SIZE`, `ECLUME_DB_MAX_OVERFLOW`) and the open-jobs index."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import text

from eclume_server.config import Settings
from eclume_server.db.session import make_runtime_engine
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    import pytest
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server_testing.harness import Services


def _pool(settings: Settings, *, worker: bool) -> tuple[int, int]:
    engine = make_runtime_engine(settings, worker=worker)
    try:
        return engine.pool.size(), engine.pool._max_overflow  # noqa: SLF001 — SQLAlchemy does not expose the ceiling
    finally:
        run(engine.dispose())


def test_default_pool_of_the_api_and_the_worker():
    assert _pool(Settings(), worker=False) == (5, 5)
    assert _pool(Settings(), worker=True) == (3, 2)


def test_pool_from_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ECLUME_DB_POOL_SIZE", "7")
    monkeypatch.setenv("ECLUME_DB_MAX_OVERFLOW", "0")
    assert _pool(Settings(), worker=False) == (7, 0)
    assert _pool(Settings(), worker=True) == (7, 0)


def test_partial_index_of_the_open_jobs(services: Services):
    async def go(conn: AsyncConnection) -> str:
        sql = "SELECT indexdef FROM pg_indexes WHERE indexname = 'transcription_jobs_open_state_idx'"
        return (await conn.execute(text(sql))).scalar_one()

    definition = run(services.sql(go))
    assert "(state)" in definition
    assert "queued" in definition
    assert "running" in definition
