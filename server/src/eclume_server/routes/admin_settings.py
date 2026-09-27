"""Configuração em runtime da plataforma (`/admin/settings`). Só a sessão de admin."""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy import func, select, update

from eclume_server.auth import Admin
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.settings_admin import AdminSettingsPatch, changes_of, merge, settings_json, validate_merged
from eclume_server.voice import purge_embeddings, voice_settings

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

router = APIRouter(prefix="/admin")
Ctx = Annotated[AppContext, Depends(get_ctx)]


async def _read(conn: AsyncConnection, *, lock: bool = False) -> Row:
    query = select(t.platform_settings, t.admins.c.name.label("updated_by_name")).outerjoin(
        t.admins, t.admins.c.id == t.platform_settings.c.updated_by
    )
    if lock:
        query = query.with_for_update(of=t.platform_settings)
    return (await conn.execute(query)).mappings().one()


@router.get("/settings")
async def get_admin_settings(_: Admin, ctx: Ctx) -> dict[str, Any]:
    """Configuração atual da plataforma."""
    async with system_tx(ctx.engine) as conn:
        row = await _read(conn)
    return settings_json(row, row["updated_by_name"])


@router.patch("/settings")
async def update_admin_settings(body: AdminSettingsPatch, admin: Admin, ctx: Ctx) -> dict[str, Any]:
    """Mescla os campos enviados; a configuração resultante vale para os próximos jobs."""
    changes = changes_of(body)
    async with system_tx(ctx.engine) as conn:
        current = await _read(conn, lock=True)
        merged = merge(current, changes)
        voice_before = voice_settings(current["voice_identification"])
        merged["voice_identification"] = voice_settings(merged["voice_identification"])
        validate_merged(merged)
        turned_off = voice_before["enabled"] and not merged["voice_identification"]["enabled"]
        if turned_off:
            # LGPD: desligada, nenhuma impressão de voz por gravação fica guardada na plataforma.
            await purge_embeddings(conn)
        await conn.execute(
            update(t.platform_settings).values(**merged, updated_at=func.now(), updated_by=admin.admin_id)
        )
        row = await _read(conn)
    if turned_off:
        # Os `speaker_embeddings.json` do bucket saem no worker CPU, depois do commit.
        await ctx.queue.enqueue_purge_embedding_objects()
    return settings_json(row, row["updated_by_name"])
