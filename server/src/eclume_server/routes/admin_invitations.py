"""Convites da organização (`/admin/invitations`). Só sessão de `admin`."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, insert, select, tuple_

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.invitations import ACCEPT_PATH, DEFAULT_TTL_DAYS, invitation_json, invitation_select
from eclume_server.pagination import Cursor, Limit, decode_cursor, page
from eclume_server.problems import conflict, invalid_field, not_found
from eclume_server.routes.auth import check_email
from eclume_server.security import new_invitation_token, sha256_hex

router = APIRouter(prefix="/admin")
Ctx = Annotated[AppContext, Depends(get_ctx)]
Admin = Annotated[Principal, Depends(requires(session_only=True, admin=True))]


class InvitationCreate(BaseModel):
    """Schema `InvitationCreate`."""

    email: str
    role: Literal["admin", "member"] = "member"
    group_ids: list[UUID] = Field(default_factory=list)
    expires_in_days: int = Field(default=DEFAULT_TTL_DAYS, ge=1, le=30)

    _email = field_validator("email")(check_email)


@router.get("/invitations")
async def list_invitations(principal: Admin, ctx: Ctx, cursor: Cursor = None, limit: Limit = 50) -> dict[str, Any]:
    """Convites da organização, do mais novo para o mais antigo."""
    c = t.invitations.c
    query = invitation_select().order_by(c.created_at.desc(), c.id.desc()).limit(limit + 1)
    if cursor:
        query = query.where(tuple_(c.created_at, c.id) < decode_cursor(cursor))
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        rows = list((await conn.execute(query)).mappings().all())
    now = datetime.now(UTC)
    return page([invitation_json(row, now) for row in rows], rows, limit, "created_at")


@router.post("/invitations", status_code=201)
async def create_invitation(body: InvitationCreate, principal: Admin, ctx: Ctx, request: Request) -> dict[str, Any]:
    """Cria o convite; o link com o token volta só nesta resposta."""
    email = body.email.strip()
    group_ids = list(dict.fromkeys(body.group_ids))
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        found = (await conn.execute(select(func.count()).where(t.groups.c.id.in_(group_ids)))).scalar_one()
        if found != len(group_ids):
            raise invalid_field("group_ids", "grupo inexistente na organização")
        # O e-mail é único na instância: a busca olha além da organização, com o papel de sistema.
        async with system_tx(ctx.engine) as system:
            taken = (
                await system.execute(select(t.users.c.id).where(func.lower(t.users.c.email) == email.lower()))
            ).first()
        if taken is not None:
            raise conflict("Já existe uma conta com este e-mail.")
        pending = (
            await conn.execute(
                select(t.invitations.c.id).where(
                    func.lower(t.invitations.c.email) == email.lower(),
                    t.invitations.c.accepted_at.is_(None),
                    t.invitations.c.expires_at > func.now(),
                )
            )
        ).first()
        if pending is not None:
            raise conflict("Já há um convite pendente para este e-mail; revogue-o antes de convidar de novo.")
        token = new_invitation_token()
        invitation_id = (
            await conn.execute(
                insert(t.invitations)
                .values(
                    org_id=principal.org_id,
                    email=email,
                    role=body.role,
                    group_ids=group_ids,
                    token_hash=sha256_hex(token),
                    expires_at=datetime.now(UTC) + timedelta(days=body.expires_in_days),
                    created_by=principal.user_id,
                )
                .returning(t.invitations.c.id)
            )
        ).scalar_one()
        row = (await conn.execute(invitation_select().where(t.invitations.c.id == invitation_id))).mappings().one()
    base = (ctx.settings.public_url or str(request.base_url)).rstrip("/")
    return invitation_json(row, datetime.now(UTC), accept_url=f"{base}{ACCEPT_PATH}{token}")


@router.delete("/invitations/{invitation_id}", status_code=204)
async def revoke_invitation(invitation_id: UUID, principal: Admin, ctx: Ctx) -> Response:
    """Revoga (apaga) um convite ainda não aceito; aceito ou inexistente → 404."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        result = await conn.execute(
            delete(t.invitations).where(t.invitations.c.id == invitation_id, t.invitations.c.accepted_at.is_(None))
        )
    if result.rowcount == 0:
        raise not_found("Convite inexistente ou já aceito.")
    return Response(status_code=204)
