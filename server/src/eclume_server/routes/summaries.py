"""Resumos versionados de transcrições, pelas instruções de um tipo de agenda.

Tudo é do dono: a RLS mostra só os tipos, as transcrições e os resumos da conta.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, tuple_
from sqlalchemy.ext.asyncio import AsyncConnection

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.pagination import Cursor, Limit, decode_ordered_position, encode_position
from eclume_server.problems import not_found
from eclume_server.quotas import charge_agent, check_open_summaries
from eclume_server.serialize import Row
from eclume_server.summaries import (
    create_summary,
    delete_all,
    edit_summary,
    recording_transcript,
    revert_summary,
    summary_agenda_type,
    summary_json,
    summary_provider,
    summary_state,
    touch_recording,
)

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("summaries:read"))]
Writer = Annotated[Principal, Depends(requires("summaries:write"))]


class SummaryCreate(BaseModel):
    """Schema `SummaryCreate`."""

    agenda_type_id: UUID | None = None
    provider_id: UUID | None = None


class SummaryEdit(BaseModel):
    """Schema `SummaryEdit`."""

    content_md: str = Field(min_length=1, max_length=200_000)
    base_version: int = Field(ge=0)


# --- resumos ------------------------------------------------------------------------------------


async def _transcript(conn: AsyncConnection, transcript_id: UUID) -> Row:
    """Transcrição do usuário, ou 404."""
    row = (await conn.execute(select(t.transcripts).where(t.transcripts.c.id == transcript_id))).mappings().first()
    if row is None:
        raise not_found("Transcrição inexistente ou sem acesso.")
    return row


async def _summary(conn: AsyncConnection, summary_id: UUID) -> Row:
    row = (await conn.execute(select(t.summaries).where(t.summaries.c.id == summary_id))).mappings().first()
    if row is None:
        raise not_found("Resumo inexistente ou sem acesso.")
    return row


@router.get("/transcripts/{transcript_id}/summaries")
async def list_summaries(
    transcript_id: UUID, principal: Reader, ctx: Ctx, cursor: Cursor = None, limit: Limit = 50
) -> dict[str, Any]:
    """Resumos da transcrição, da maior `version` para a menor (a geração toma o número ao terminar)."""
    c = t.summaries.c
    query = (
        select(t.summaries)
        .where(c.transcript_id == transcript_id)
        .order_by(c.version.desc(), c.id.desc())
        .limit(limit + 1)
    )
    if cursor:
        query = query.where(tuple_(c.version, c.id) < decode_ordered_position(cursor))
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await _transcript(conn, transcript_id)
        rows = list((await conn.execute(query)).mappings().all())
    next_cursor = encode_position(rows[limit - 1]["version"], rows[limit - 1]["id"]) if len(rows) > limit else None
    return {"items": [summary_json(row) for row in rows[:limit]], "next_cursor": next_cursor}


@router.post("/transcripts/{transcript_id}/summaries", status_code=202)
async def create_transcript_summary(
    transcript_id: UUID, body: SummaryCreate, principal: Writer, ctx: Ctx
) -> dict[str, Any]:
    """Gera uma nova versão do resumo daquele tipo de agenda, na fila do worker CPU."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        transcript = await _transcript(conn, transcript_id)
        agenda_type = await summary_agenda_type(conn, transcript, body.agenda_type_id)
        provider = await summary_provider(conn, body.provider_id)
        await check_open_summaries(conn, principal.user_id)
        row = await create_summary(
            conn,
            transcript=transcript,
            agenda_type=agenda_type,
            provider=provider,
            trigger="manual",
            created_by=principal.user_id,
        )
        await charge_agent(conn, ctx.queue.pool, principal.user_id)
    await ctx.queue.enqueue_summarize(row["id"])
    return summary_json(row)


@router.get("/summaries/{summary_id}")
async def get_summary(summary_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Um resumo (o cliente consulta até `done` ou `failed`)."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return summary_json(await _summary(conn, summary_id))


@router.delete("/summaries/{summary_id}", status_code=204)
async def delete_summary(summary_id: UUID, principal: Writer, ctx: Ctx) -> Response:
    """Exclui uma versão; um job ainda na fila encontra o resumo apagado e não faz nada."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        transcript_id = (
            await conn.execute(
                delete(t.summaries).where(t.summaries.c.id == summary_id).returning(t.summaries.c.transcript_id)
            )
        ).scalar_one_or_none()
        if transcript_id is not None:
            await touch_recording(conn, transcript_id)
    if transcript_id is None:
        raise not_found("Resumo inexistente ou sem acesso.")
    return Response(status_code=204)


# --- o resumo da gravação: versões ---------------------------------------------------------------


@router.get("/recordings/{recording_id}/summary")
async def get_recording_summary(recording_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """A versão atual, a gerada de referência e a geração em aberto."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        transcript = await recording_transcript(conn, recording_id)
        return await summary_state(conn, transcript["id"])


@router.put("/recordings/{recording_id}/summary")
async def put_recording_summary(recording_id: UUID, body: SummaryEdit, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Grava a edição à mão como versão `manual` (409 `summary_changed` se outra entrou antes)."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        transcript = await recording_transcript(conn, recording_id)
        row = await edit_summary(conn, transcript, body.content_md, body.base_version, principal.user_id)
    return summary_json(row)


@router.post("/recordings/{recording_id}/summary/revert", status_code=201)
async def revert_recording_summary(recording_id: UUID, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Volta à gerada de referência numa versão nova (409 `summary_missing` sem gerada)."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        transcript = await recording_transcript(conn, recording_id)
        row = await revert_summary(conn, transcript, principal.user_id)
    return summary_json(row)


@router.delete("/recordings/{recording_id}/summary", status_code=204)
async def delete_recording_summary(recording_id: UUID, principal: Writer, ctx: Ctx) -> Response:
    """Apaga todas as versões e o chat de ajuste da gravação."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        transcript = await recording_transcript(conn, recording_id)
        await delete_all(conn, transcript)
        await touch_recording(conn, transcript["id"])
    return Response(status_code=204)
