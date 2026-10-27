"""The account's mandatory speaker naming: `GET`/`PATCH /me/speaker-naming`.

Reading accepts a PAT with `recordings:read` (the clients show how many recordings are waiting);
writing, only the session. Turning it on applies to future ingestions; turning it off releases, in
the same transaction, every held recording of the account and enqueues the chain of each one after
the commit. Rules in docs/standards/code/processamento-automatico.md `§Marcação dos locutores`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, update

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.speaker_naming import release_account, waiting_count

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("recordings:read"))]
Member = Annotated[Principal, Depends(requires(session_only=True))]


class SpeakerNamingPatch(BaseModel):
    """Body of `PATCH /me/speaker-naming`."""

    model_config = ConfigDict(extra="forbid")

    required: bool


async def _preference_json(conn: AsyncConnection, user_id: UUID) -> dict[str, Any]:
    """Schema `SpeakerNamingPreference`."""
    required = (await conn.execute(select(t.users.c.require_speaker_naming).where(t.users.c.id == user_id))).scalar()
    return {"required": bool(required), "waiting_count": await waiting_count(conn)}


@router.get("/me/speaker-naming")
async def get_speaker_naming(principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Whether the account requires naming the speakers and how many recordings are waiting for it."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await _preference_json(conn, principal.user_id)


@router.patch("/me/speaker-naming")
async def patch_speaker_naming(body: SpeakerNamingPatch, principal: Member, ctx: Ctx) -> dict[str, Any]:
    """Turn mandatory naming on or off; turning it off releases the held recordings."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await conn.execute(
            update(t.users).where(t.users.c.id == principal.user_id).values(require_speaker_naming=body.required)
        )
        released = [] if body.required else await release_account(conn, principal.user_id)
        result = await _preference_json(conn, principal.user_id)
    for recording_id, revision in released:
        await ctx.queue.enqueue_step("detect_agenda_type", recording_id, revision)
    return result
