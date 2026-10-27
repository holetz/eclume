"""Engine and transactions: system (connection role) or user (`eclume_app` + RLS)."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

if TYPE_CHECKING:
    from collections.abc import AsyncIterator
    from uuid import UUID

    from eclume_server.config import Settings

# Fixed and overflow connections per process: the API serves requests in parallel, the worker runs
# short transactions per job.
API_POOL = (5, 5)
WORKER_POOL = (3, 2)

_SET_CONTEXT = text("SELECT set_config('app.user_id', :user, true)")


def make_engine(database_url: str) -> AsyncEngine:
    """Async engine (asyncpg) with a pool."""
    return create_async_engine(database_url, pool_pre_ping=True)


def make_runtime_engine(settings: Settings, *, worker: bool = False) -> AsyncEngine:
    """Engine of the API or the worker, with the pool of `ECLUME_DB_POOL_SIZE`/`ECLUME_DB_MAX_OVERFLOW` (or the default)."""
    size, overflow = WORKER_POOL if worker else API_POOL
    return create_async_engine(
        settings.database_url,
        pool_pre_ping=True,
        pool_size=size if settings.db_pool_size is None else settings.db_pool_size,
        max_overflow=overflow if settings.db_max_overflow is None else settings.db_max_overflow,
    )


@asynccontextmanager
async def system_tx(engine: AsyncEngine) -> AsyncIterator[AsyncConnection]:
    """Transaction with the connection role, outside RLS: credentials, admin panel, worker."""
    async with engine.begin() as conn:
        yield conn


async def enter_user_context(conn: AsyncConnection, user_id: UUID) -> None:
    """Drop the current transaction to `eclume_app` and pin the RLS user (the only context)."""
    await conn.execute(text("SET LOCAL ROLE eclume_app"))
    await conn.execute(_SET_CONTEXT, {"user": str(user_id)})


@asynccontextmanager
async def user_tx(engine: AsyncEngine, user_id: UUID) -> AsyncIterator[AsyncConnection]:
    """Transaction under RLS, as the user: sees only what is theirs."""
    async with engine.begin() as conn:
        await enter_user_context(conn, user_id)
        yield conn
