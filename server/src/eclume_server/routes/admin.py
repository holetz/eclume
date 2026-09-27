"""Contas de usuário vistas pelo admin (`/admin/users`). Só a sessão de admin.

O admin lê só dados da conta e a contagem de gravações, nunca o conteúdo; muda só `active`.
Roda com o papel de conexão: as contas não são do admin para a RLS.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import delete, func, select, tuple_, update

from eclume_server.auth import require_admin
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.pagination import Cursor, Limit, decode_cursor, page
from eclume_server.problems import not_found
from eclume_server.serialize import Row, user_json

router = APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])
Ctx = Annotated[AppContext, Depends(get_ctx)]

_recording_count = (
    select(func.count())
    .select_from(t.recordings)
    .where(t.recordings.c.owner_id == t.users.c.id)
    .scalar_subquery()
    .label("recording_count")
)


class UserPatch(BaseModel):
    """Schema `UserPatch`."""

    active: bool


def admin_user_json(row: Row) -> dict[str, Any]:
    """Schema `AdminUser`."""
    return {**user_json(row), "recording_count": row["recording_count"]}


def _users() -> Any:  # noqa: ANN401 — Select do SQLAlchemy
    return select(t.users, _recording_count)


@router.get("/users")
async def list_users(ctx: Ctx, cursor: Cursor = None, limit: Limit = 50) -> dict[str, Any]:
    """Contas de usuário, da mais nova para a mais antiga."""
    query = _users().order_by(t.users.c.created_at.desc(), t.users.c.id.desc()).limit(limit + 1)
    if cursor:
        query = query.where(tuple_(t.users.c.created_at, t.users.c.id) < decode_cursor(cursor))
    async with system_tx(ctx.engine) as conn:
        rows = (await conn.execute(query)).mappings().all()
    return page([admin_user_json(row) for row in rows], list(rows), limit, "created_at")


@router.patch("/users/{user_id}")
async def update_user(user_id: UUID, body: UserPatch, ctx: Ctx) -> dict[str, Any]:
    """Desativa ou reativa a conta; desativar encerra as sessões e revoga os PATs do usuário."""
    async with system_tx(ctx.engine) as conn:
        changed = await conn.execute(update(t.users).where(t.users.c.id == user_id).values(active=body.active))
        if changed.rowcount == 0:
            raise not_found("Usuário inexistente.")
        if not body.active:
            await conn.execute(delete(t.sessions).where(t.sessions.c.user_id == user_id))
            await conn.execute(
                update(t.api_tokens)
                .where(t.api_tokens.c.user_id == user_id, t.api_tokens.c.revoked_at.is_(None))
                .values(revoked_at=datetime.now(UTC))
            )
        row = (await conn.execute(_users().where(t.users.c.id == user_id))).mappings().one()
    return admin_user_json(row)
