"""Previews (`GET /previews/{id}`): the result of testing a field or an agenda type.

The request is born in `POST /fields/preview` and `POST /agenda-types/preview`; the state lives 1 h
in Redis, and another account's preview is 404.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy import select

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.previews import get_preview
from eclume_server.problems import invalid_field, not_found

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("recordings:read"))]


async def check_transcribed(conn: AsyncConnection, recording_ids: list[UUID], field: str) -> None:
    """422 if some recording is not the user's (RLS hides it) or has no transcript yet."""
    wanted = set(recording_ids)
    query = select(t.transcripts.c.recording_id).where(t.transcripts.c.recording_id.in_(wanted))
    if wanted - set((await conn.execute(query)).scalars()):
        raise invalid_field(field, "gravação inexistente ou ainda sem transcrição")


@router.get("/previews/{preview_id}")
async def read_preview(preview_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """The preview's state; the client polls until `done` or `failed`."""
    preview = await get_preview(ctx.queue.pool, preview_id, principal.user_id)
    if preview is None:
        raise not_found("Pré-visualização inexistente, expirada ou de outra conta.")
    return preview
