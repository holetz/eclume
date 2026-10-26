"""Audio retention preference of the account: `GET`/`PATCH /me/audio-retention`.

Reading accepts a PAT with `recordings:read`; writing is session only. `days` null turns retention
off (the default). The ceiling is the admin's `retention.audio_max_days`; it only caps `days`.
Rules in docs/standards/code/server-nucleo.md §Audio retention.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from eclume_server.audio_retention import MAX_DAYS, MIN_DAYS, retention_json, set_account_days
from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db.session import user_tx

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("recordings:read"))]
Member = Annotated[Principal, Depends(requires(session_only=True))]


class AudioRetentionPatch(BaseModel):
    """Corpo do `PATCH /me/audio-retention`: `days` nulo desliga a retenção."""

    model_config = ConfigDict(extra="forbid")

    days: int | None = Field(ge=MIN_DAYS, le=MAX_DAYS)


@router.get("/me/audio-retention")
async def get_audio_retention(principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Os dias da conta, o teto da plataforma e a janela que de fato vale."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await retention_json(conn, principal.user_id)


@router.patch("/me/audio-retention")
async def patch_audio_retention(body: AudioRetentionPatch, principal: Member, ctx: Ctx) -> dict[str, Any]:
    """Muda os dias da conta; o job diário apaga o áudio das gravações mais antigas que a janela."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await set_account_days(conn, principal.user_id, body.days)
        return await retention_json(conn, principal.user_id)
