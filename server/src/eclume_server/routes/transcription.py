"""Idioma de transcrição preferido da conta: `GET`/`PATCH /me/transcription`.

A leitura aceita PAT com `recordings:read` (o desktop e o celular nomeiam o padrão da conta); a
escrita, só a sessão. Nulo é o padrão do servidor (`asr.default_language`). A ordem de resolução
está em docs/standards/api/jobs-transcricao.md.
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
    """Corpo do `PATCH /me/transcription`: `language` nulo volta ao padrão do servidor."""

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
    """O idioma preferido da conta e o padrão do servidor, para os clientes o nomearem."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await _preference_json(conn, principal.user_id)


@router.patch("/me/transcription")
async def patch_transcription_preference(
    body: TranscriptionPreferencePatch, principal: Member, ctx: Ctx
) -> dict[str, Any]:
    """Muda o idioma preferido; vale para os próximos jobs, não para os já na fila."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await conn.execute(
            update(t.users).where(t.users.c.id == principal.user_id).values(transcription_language=body.language)
        )
        return await _preference_json(conn, principal.user_id)
