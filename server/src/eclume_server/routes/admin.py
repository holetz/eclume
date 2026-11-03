"""User accounts as the admin sees them (`/admin/users`). Admin session only.

The admin reads only account data, the recording count and usage, never the content; changes
`active` and the quota override, generates the password reset link (never sees or sets the password)
and deletes the account. Runs with the connection role: the accounts are not the admin's for RLS.
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
    """Schema `UserPatch`: `quotas` replaces the whole override (`null` returns to the default)."""

    model_config = ConfigDict(extra="forbid")

    active: bool | None = None
    quotas: QuotasPatch | None = None


async def admin_user_json(conn: AsyncConnection, ctx: AppContext, row: Row) -> dict[str, Any]:
    """Schema `AdminUser`: with the account's usage and the quota override."""
    return {
        **user_json(row),
        "recording_count": row["recording_count"],
        "quotas": row["quotas"],
        "usage": (await usage(conn, ctx.queue.pool, row["id"]))["usage"],
    }


def _users() -> Any:  # noqa: ANN401 — an SQLAlchemy Select
    return select(t.users, _recording_count)


@router.get("/users")
async def list_users(ctx: Ctx, cursor: Cursor = None, limit: Limit = 50) -> dict[str, Any]:
    """User accounts, from the newest to the oldest."""
    query = _users().order_by(t.users.c.created_at.desc(), t.users.c.id.desc()).limit(limit + 1)
    if cursor:
        query = query.where(tuple_(t.users.c.created_at, t.users.c.id) < decode_cursor(cursor))
    async with system_tx(ctx.engine) as conn:
        rows = (await conn.execute(query)).mappings().all()
        items = [await admin_user_json(conn, ctx, row) for row in rows[:limit]]
    return page(items, list(rows), limit, "created_at")


@router.patch("/users/{user_id}")
async def update_user(user_id: UUID, body: UserPatch, ctx: Ctx) -> dict[str, Any]:
    """Deactivate or reactivate the account and replace the quota override.

    Deactivating ends the sessions, revokes the PATs and expires the user's pending reset link.
    """
    sent = body.model_dump(exclude_unset=True)
    if not sent:
        raise invalid_field("body", "send at least one field")
    if sent.get("active", False) is None:
        raise invalid_field("active", "cannot be null")
    values: dict[str, Any] = {}
    if "active" in sent:
        values["active"] = body.active
    if "quotas" in sent:
        values["quotas"] = null() if body.quotas is None else body.quotas.model_dump(exclude_unset=True)
    async with system_tx(ctx.engine) as conn:
        changed = await conn.execute(update(t.users).where(t.users.c.id == user_id).values(**values))
        if changed.rowcount == 0:
            raise not_found("User does not exist.")
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
    """The account's password reset link, valid for 24 h, with the server's public URL."""
    url = server_info(ctx.settings, str(request.base_url))["url"]
    async with system_tx(ctx.engine) as conn:
        active = (await conn.execute(select(t.users.c.active).where(t.users.c.id == user_id))).scalar()
        if active is None:
            raise not_found("User does not exist.")
        if not active:
            raise conflict("A deactivated account does not receive a reset link.")
        return await create_password_reset(conn, user_id, admin.admin_id, url)


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(user_id: UUID, ctx: Ctx) -> Response:
    """Delete the account and all its data, like the person's own deletion, without the password.

    The objects leave the bucket through the deletion queue; the e-mail becomes free for a new sign-up.
    """
    async with system_tx(ctx.engine) as conn:
        open_jobs = await open_jobs_of(conn, user_id)
        if not await purge_user(conn, user_id):
            raise not_found("User does not exist.")
    # The GPU does not keep transcribing what the deleted account had queued or in progress.
    await ctx.queue.request_cancel(open_jobs)
    return Response(status_code=204)
