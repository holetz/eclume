"""Engine e transações: de sistema (papel de conexão) ou de usuário (`eclume_app` + RLS)."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

if TYPE_CHECKING:
    from collections.abc import AsyncIterator
    from uuid import UUID

_SET_CONTEXT = text("SELECT set_config('app.org_id', :org, true), set_config('app.user_id', :user, true)")


def make_engine(database_url: str) -> AsyncEngine:
    """Engine assíncrono (asyncpg) com pool."""
    return create_async_engine(database_url, pool_pre_ping=True)


@asynccontextmanager
async def system_tx(engine: AsyncEngine) -> AsyncIterator[AsyncConnection]:
    """Transação com o papel de conexão, fora da RLS: credenciais, bootstrap, worker."""
    async with engine.begin() as conn:
        yield conn


async def enter_user_context(conn: AsyncConnection, org_id: UUID, user_id: UUID) -> None:
    """Baixa a transação corrente para `eclume_app` e fixa organização e usuário da RLS."""
    await conn.execute(text("SET LOCAL ROLE eclume_app"))
    await conn.execute(_SET_CONTEXT, {"org": str(org_id), "user": str(user_id)})


@asynccontextmanager
async def user_tx(engine: AsyncEngine, org_id: UUID, user_id: UUID) -> AsyncIterator[AsyncConnection]:
    """Transação sob a RLS, como o usuário da organização."""
    async with engine.begin() as conn:
        await enter_user_context(conn, org_id, user_id)
        yield conn
