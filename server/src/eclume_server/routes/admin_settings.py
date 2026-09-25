"""Configuração em runtime da organização (`/admin/settings`). Só sessão de `admin`."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy import func, select, update

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.settings_admin import BLOCKS, AdminSettingsPatch, changes_of, settings_json, validate_merged

router = APIRouter(prefix="/admin")
Ctx = Annotated[AppContext, Depends(get_ctx)]
Admin = Annotated[Principal, Depends(requires(session_only=True, admin=True))]


async def _read(conn: Any, principal: Principal, *, lock: bool = False) -> Any:  # noqa: ANN401 — conexão e linha do SQLAlchemy
    query = (
        select(t.org_settings, t.users.c.name.label("updated_by_name"))
        .outerjoin(t.users, t.users.c.id == t.org_settings.c.updated_by)
        .where(t.org_settings.c.org_id == principal.org_id)
    )
    if lock:
        query = query.with_for_update(of=t.org_settings)
    return (await conn.execute(query)).mappings().one()


@router.get("/settings")
async def get_admin_settings(principal: Admin, ctx: Ctx) -> dict[str, Any]:
    """Configuração atual da organização."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        row = await _read(conn, principal)
    return settings_json(row, row["updated_by_name"])


@router.patch("/settings")
async def update_admin_settings(body: AdminSettingsPatch, principal: Admin, ctx: Ctx) -> dict[str, Any]:
    """Mescla os campos enviados; a configuração resultante vale para os próximos jobs."""
    changes = changes_of(body)
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        current = await _read(conn, principal, lock=True)
        merged = {block: {**current[block], **changes.get(block, {})} for block in BLOCKS}
        await validate_merged(conn, merged)
        await conn.execute(
            update(t.org_settings)
            .where(t.org_settings.c.org_id == principal.org_id)
            .values(**merged, updated_at=func.now(), updated_by=principal.user_id)
        )
        row = await _read(conn, principal)
    return settings_json(row, row["updated_by_name"])
