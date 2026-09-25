"""Administração de usuários da organização (`/admin/users`). Só sessão de `admin`."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, text, tuple_, update

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.pagination import Cursor, Limit, decode_cursor, page
from eclume_server.problems import conflict, invalid_field, not_found
from eclume_server.serialize import user_json

router = APIRouter(prefix="/admin")
Ctx = Annotated[AppContext, Depends(get_ctx)]
Admin = Annotated[Principal, Depends(requires(session_only=True, admin=True))]


class UserPatch(BaseModel):
    """Schema `UserPatch`."""

    name: str | None = Field(default=None, min_length=1)
    role: Literal["admin", "member"] | None = None
    active: bool | None = None


@router.get("/users")
async def list_users(principal: Admin, ctx: Ctx, cursor: Cursor = None, limit: Limit = 50) -> dict[str, Any]:
    """Usuários da organização, do mais novo para o mais antigo."""
    query = select(t.users).order_by(t.users.c.created_at.desc(), t.users.c.id.desc()).limit(limit + 1)
    if cursor:
        query = query.where(tuple_(t.users.c.created_at, t.users.c.id) < decode_cursor(cursor))
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        rows = (await conn.execute(query)).mappings().all()
    return page([user_json(row) for row in rows], list(rows), limit, "created_at")


@router.patch("/users/{user_id}")
async def update_user(user_id: UUID, body: UserPatch, principal: Admin, ctx: Ctx) -> dict[str, Any]:
    """Muda nome, papel ou atividade; desativar encerra as sessões e revoga os PATs do usuário."""
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise invalid_field("body", "informe ao menos um campo")
    for field, value in values.items():
        if value is None:
            raise invalid_field(field, "não pode ser nulo")
    # Sob a RLS, `users` só enxerga a organização do admin.
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        target = (await conn.execute(select(t.users).where(t.users.c.id == user_id))).mappings().first()
        if target is None:
            raise not_found("Usuário inexistente.")
        row = (
            (await conn.execute(update(t.users).where(t.users.c.id == user_id).values(**values).returning(t.users)))
            .mappings()
            .one()
        )
        admins = (
            await conn.execute(
                select(func.count()).select_from(t.users).where(t.users.c.role == "admin", t.users.c.active)
            )
        ).scalar_one()
        if admins == 0:
            raise conflict("A organização precisa manter ao menos um admin ativo.")
        # Sessões e PATs alheios estão fora do alcance de `eclume_app`: volta ao papel de sistema.
        await conn.execute(text("SET LOCAL ROLE NONE"))
        if values.get("active") is False:
            await conn.execute(delete(t.sessions).where(t.sessions.c.user_id == user_id))
            await conn.execute(
                update(t.api_tokens)
                .where(t.api_tokens.c.user_id == user_id, t.api_tokens.c.revoked_at.is_(None))
                .values(revoked_at=datetime.now(UTC))
            )
    return user_json(row)
