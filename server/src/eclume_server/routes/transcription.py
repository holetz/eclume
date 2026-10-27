"""The account's preferred transcription language: `GET`/`PATCH /me/transcription`.

Reading accepts a PAT with `recordings:read` (the desktop and the phone name the account's default);
writing, only the session. Null is the server default (`asr.default_language`). The resolution
order is in docs/standards/api/jobs-transcricao.md.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.queue import DEFAULT_LANGUAGE
from eclume_server.recordings import account_language
from eclume_server.routes.uploads import LANGUAGE

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("recordings:read"))]
Member = Annotated[Principal, Depends(requires(session_only=True))]


class TranscriptionPreferencePatch(BaseModel):
    """Body of `PATCH /me/transcription`: a null `language` returns to the server default."""

    model_config = ConfigDict(extra="forbid")

    language: str | None = Field(pattern=LANGUAGE)


async def _preference_json(conn: AsyncConnection, user_id: UUID) -> dict[str, Any]:
    """Schema `TranscriptionPreference`."""
    asr = (await conn.execute(select(t.platform_settings.c.asr))).scalar_one()
    return {
        "language": await account_language(conn, user_id),
        "platform_default": asr.get("default_language") or DEFAULT_LANGUAGE,
    }


@router.get("/me/transcription")
async def get_transcription_preference(principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """The account's preferred language and the server default, for the clients to name it."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await _preference_json(conn, principal.user_id)


@router.patch("/me/transcription")
async def patch_transcription_preference(
    body: TranscriptionPreferencePatch, principal: Member, ctx: Ctx
) -> dict[str, Any]:
    """Change the preferred language; it applies to future jobs, not to those already queued."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await conn.execute(
            update(t.users).where(t.users.c.id == principal.user_id).values(transcription_language=body.language)
        )
        return await _preference_json(conn, principal.user_id)
