"""Contas de usuário vistas pelo admin (`/admin/users`). Só a sessão de admin.

O admin lê só dados da conta, a contagem de gravações e o uso, nunca o conteúdo; muda `active` e a
sobreposição das cotas, gera o link de redefinição de senha (nunca vê nem define a senha) e exclui a
conta. Roda com o papel de conexão: as contas não são do admin
para a RLS.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy import delete, func, null, select, tuple_, update

from eclume_server.accounts import create_password_reset, expire_password_resets, purge_user
from eclume_server.auth import Admin, require_admin
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.pagination import Cursor, Limit, decode_cursor, page
from eclume_server.problems import conflict, invalid_field, not_found
from eclume_server.quotas import usage
from eclume_server.recordings import open_jobs_of
from eclume_server.serialize import Row, user_json
from eclume_server.server_info import server_info
from eclume_server.settings_admin import QuotasPatch

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection

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
    """Schema `UserPatch`: `quotas` troca a sobreposição inteira (`null` volta ao padrão)."""

    model_config = ConfigDict(extra="forbid")

    active: bool | None = None
    quotas: QuotasPatch | None = None


async def admin_user_json(conn: AsyncConnection, ctx: AppContext, row: Row) -> dict[str, Any]:
    """Schema `AdminUser`: com o uso da conta e a sobreposição das cotas."""
    return {
        **user_json(row),
        "recording_count": row["recording_count"],
        "quotas": row["quotas"],
        "usage": (await usage(conn, ctx.queue.pool, row["id"]))["usage"],
    }


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
        items = [await admin_user_json(conn, ctx, row) for row in rows[:limit]]
    return page(items, list(rows), limit, "created_at")


@router.patch("/users/{user_id}")
async def update_user(user_id: UUID, body: UserPatch, ctx: Ctx) -> dict[str, Any]:
    """Desativa ou reativa a conta e troca a sobreposição das cotas.

    Desativar encerra as sessões, revoga os PATs e vence o link de redefinição pendente do usuário.
    """
    sent = body.model_dump(exclude_unset=True)
    if not sent:
        raise invalid_field("body", "informe ao menos um campo")
    if sent.get("active", False) is None:
        raise invalid_field("active", "não pode ser nulo")
    values: dict[str, Any] = {}
    if "active" in sent:
        values["active"] = body.active
    if "quotas" in sent:
        values["quotas"] = null() if body.quotas is None else body.quotas.model_dump(exclude_unset=True)
    async with system_tx(ctx.engine) as conn:
        changed = await conn.execute(update(t.users).where(t.users.c.id == user_id).values(**values))
        if changed.rowcount == 0:
            raise not_found("Usuário inexistente.")
        if body.active is False:
            await conn.execute(delete(t.sessions).where(t.sessions.c.user_id == user_id))
            await expire_password_resets(conn, user_id)
            await conn.execute(
                update(t.api_tokens)
                .where(t.api_tokens.c.user_id == user_id, t.api_tokens.c.revoked_at.is_(None))
                .values(revoked_at=datetime.now(UTC))
            )
        row = (await conn.execute(_users().where(t.users.c.id == user_id))).mappings().one()
        return await admin_user_json(conn, ctx, row)


@router.post("/users/{user_id}/password-reset", status_code=201)
async def create_user_password_reset(user_id: UUID, request: Request, admin: Admin, ctx: Ctx) -> dict[str, Any]:
    """Link de redefinição de senha da conta, válido por 24 h, com a URL pública do servidor."""
    url = server_info(ctx.settings, str(request.base_url))["url"]
    async with system_tx(ctx.engine) as conn:
        active = (await conn.execute(select(t.users.c.active).where(t.users.c.id == user_id))).scalar()
        if active is None:
            raise not_found("Usuário inexistente.")
        if not active:
            raise conflict("Conta desativada não recebe link de redefinição.")
        return await create_password_reset(conn, user_id, admin.admin_id, url)


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(user_id: UUID, ctx: Ctx) -> Response:
    """Exclui a conta e todos os dados dela, como a exclusão pela própria pessoa, sem a senha.

    Os objetos saem do bucket pela fila de exclusão; o e-mail fica livre para um cadastro novo.
    """
    async with system_tx(ctx.engine) as conn:
        open_jobs = await open_jobs_of(conn, user_id)
        if not await purge_user(conn, user_id):
            raise not_found("Usuário inexistente.")
    # A GPU não segue transcrevendo o que a conta excluída tinha na fila ou em curso.
    await ctx.queue.request_cancel(open_jobs)
    return Response(status_code=204)
