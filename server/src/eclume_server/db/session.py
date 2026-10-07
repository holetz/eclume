"""Engine e transações: de sistema (papel de conexão) ou de usuário (`eclume_app` + RLS)."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

if TYPE_CHECKING:
    from collections.abc import AsyncIterator
    from uuid import UUID

    from eclume_server.config import Settings

# Conexões fixas e de reserva por processo: a API atende requisições em paralelo, o worker faz
# transações curtas por job.
API_POOL = (5, 5)
WORKER_POOL = (3, 2)

_SET_CONTEXT = text("SELECT set_config('app.user_id', :user, true)")


def make_engine(database_url: str) -> AsyncEngine:
    """Engine assíncrono (asyncpg) com pool."""
    return create_async_engine(database_url, pool_pre_ping=True)


def make_runtime_engine(settings: Settings, *, worker: bool = False) -> AsyncEngine:
    """Engine da API ou do worker, com o pool de `ECLUME_DB_POOL_SIZE`/`ECLUME_DB_MAX_OVERFLOW` (ou o padrão)."""
    size, overflow = WORKER_POOL if worker else API_POOL
    return create_async_engine(
        settings.database_url,
        pool_pre_ping=True,
        pool_size=size if settings.db_pool_size is None else settings.db_pool_size,
        max_overflow=overflow if settings.db_max_overflow is None else settings.db_max_overflow,
    )


@asynccontextmanager
async def system_tx(engine: AsyncEngine) -> AsyncIterator[AsyncConnection]:
    """Transação com o papel de conexão, fora da RLS: credenciais, painel admin, worker."""
    async with engine.begin() as conn:
        yield conn


async def enter_user_context(conn: AsyncConnection, user_id: UUID) -> None:
    """Baixa a transação corrente para `eclume_app` e fixa o usuário da RLS (o único contexto)."""
    await conn.execute(text("SET LOCAL ROLE eclume_app"))
    await conn.execute(_SET_CONTEXT, {"user": str(user_id)})


@asynccontextmanager
async def user_tx(engine: AsyncEngine, user_id: UUID) -> AsyncIterator[AsyncConnection]:
    """Transação sob a RLS, como o usuário: enxerga só o que é dele."""
    async with engine.begin() as conn:
        await enter_user_context(conn, user_id)
        yield conn
