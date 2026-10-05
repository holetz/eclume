"""Gravações do usuário: listar, obter, editar, excluir, áudio e retranscrever."""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.dispatch import next_for
from eclume_server.fields import mark_edited
from eclume_server.operations import change_agenda_type
from eclume_server.pagination import Cursor, Limit
from eclume_server.problems import conflict, forbidden, invalid_field, not_found, unauthorized
from eclume_server.recordings import (
    Awaiting,
    Library,
    Sort,
    Status,
    cancel_transcription,
    delete_recording_of,
    get_visible,
    list_library,
    lock_recording,
    render,
    start_next_revision,
)
from eclume_server.routes.collections import check_collections
from eclume_server.routes.uploads import LANGUAGE, Kind
from eclume_server.security import sign, signature_matches
from eclume_server.speaker_naming import CONTINUED, release

router = APIRouter()
media_router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("recordings:read"))]
Writer = Annotated[Principal, Depends(requires("recordings:write"))]
Deleter = Annotated[Principal, Depends(requires("recordings:delete"))]
Many = Annotated[list[str] | None, Query()]
AUDIO_URL_TTL_SECONDS = 3600


class RecordingPatch(BaseModel):
    """Schema `RecordingPatch`."""

    title: str | None = Field(default=None, min_length=1)
    recorded_at: datetime | None = None
    kind: Kind | None = None
    language: str | None = Field(default=None, pattern=LANGUAGE)
    tags: list[Annotated[str, Field(min_length=1)]] | None = None
    collection_ids: list[UUID] | None = None
    metadata: dict[str, str] | None = None
    agenda_type_id: UUID | None = None


class RetranscribeRequest(BaseModel):
    """Schema `RetranscribeRequest`."""

    language: str | None = Field(default=None, pattern=LANGUAGE)


@router.get("/recordings")
async def list_recordings(
    principal: Reader,
    ctx: Ctx,
    cursor: Cursor = None,
    limit: Limit = 50,
    since: datetime | None = None,
    from_: Annotated[datetime | None, Query(alias="from")] = None,
    to: datetime | None = None,
    sort: Sort = "created_desc",
    kind: Annotated[list[Kind] | None, Query()] = None,
    status: Annotated[list[Status] | None, Query()] = None,
    tag: Many = None,
    collection: Annotated[list[UUID] | None, Query()] = None,
    person: Annotated[list[UUID] | None, Query()] = None,
    field: Many = None,
    person_company: Many = None,
    person_department: Many = None,
    person_tag: Many = None,
    awaiting: Annotated[list[Awaiting] | None, Query()] = None,
) -> dict[str, Any]:
    """A biblioteca: por intervalo de `recorded_at` e filtros (OU no mesmo filtro, E entre filtros).

    Os atributos de pessoa (`person_*`) valem para um mesmo participante: alguém ligado a um locutor
    da gravação que cumpre todos eles.
    """
    library = Library(
        since,
        from_,
        to,
        kind,
        status,
        tag,
        collection,
        person,
        field,
        person_company=person_company,
        person_department=person_department,
        person_tag=person_tag,
        awaiting=awaiting,
    )
    return await list_library(ctx, principal.user_id, library, sort=sort, cursor=cursor, limit=limit)


@router.get("/recordings/{recording_id}")
async def get_recording(recording_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Gravação e estado do job."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        row = await get_visible(conn, recording_id)
    return (await render(ctx, principal.user_id, [row]))[0]


@router.patch("/recordings/{recording_id}")
async def update_recording(recording_id: UUID, body: RecordingPatch, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Edita os metadados (listas e `metadata` substituem o valor inteiro).

    Escolher o tipo de agenda (origem `edited`) reaplica o padrão de título e as tags padrão e abre
    um resumo automático novo pelas instruções dele; `null` tira o tipo e devolve a escolha à detecção.
    """
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise invalid_field("body", "informe ao menos um campo")
    for field, value in values.items():
        if value is None and field != "agenda_type_id":
            raise invalid_field(field, "não pode ser nulo")
    type_changed = "agenda_type_id" in values
    agenda_type_id = values.pop("agenda_type_id", None)
    if "recorded_at" in values:
        values["recorded_at_source"] = "user"
    summary_id = None
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await get_visible(conn, recording_id)
        if "collection_ids" in values:
            await check_collections(conn, values["collection_ids"])
            values["collection_ids"] = list(dict.fromkeys(values["collection_ids"]))
            # O usuário mexeu nas coleções: o agente não as muda mais.
            values["collections_origin"] = "edited"
        now = datetime.now(UTC)
        if values:
            await conn.execute(
                update(t.recordings).where(t.recordings.c.id == recording_id).values(**values, updated_at=now)
            )
            await mark_edited(conn, recording_id, principal.user_id, values)
        # Título, data e tags aparecem na transcrição: `?since=` precisa enxergar a mudança.
        await conn.execute(
            update(t.transcripts).where(t.transcripts.c.recording_id == recording_id).values(updated_at=now)
        )
        if type_changed:
            summary_id = await change_agenda_type(conn, recording_id, agenda_type_id)
        row = await get_visible(conn, recording_id)
    if summary_id is not None:
        await ctx.queue.enqueue_summarize(summary_id)
    return (await render(ctx, principal.user_id, [row]))[0]


@router.delete("/recordings/{recording_id}", status_code=204)
async def delete_recording(recording_id: UUID, principal: Deleter, ctx: Ctx) -> Response:
    """Exclui a gravação e tudo o que é dela: transcrição, versões do resumo, chat, marcadores e áudio.

    As FKs levam os filhos em cascata; um job ainda na fila encontra a gravação apagada e não faz nada.
    """
    await delete_recording_of(ctx, principal.user_id, recording_id)
    return Response(status_code=204)


@router.get("/recordings/{recording_id}/audio", status_code=302)
async def get_audio(recording_id: UUID, request: Request, principal: Reader, ctx: Ctx) -> RedirectResponse:
    """Redireciona para uma URL temporária e assinada do áudio, que aceita `Range`."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await get_visible(conn, recording_id)
    expires = int(time.time()) + AUDIO_URL_TTL_SECONDS
    sig = sign(ctx.settings.secret_key, "audio", recording_id, expires)
    base = (ctx.settings.public_url or str(request.base_url)).rstrip("/")
    return RedirectResponse(
        f"{base}/media/recordings/{recording_id}/audio?expires={expires}&sig={sig}", status_code=302
    )


@media_router.get("/media/recordings/{recording_id}/audio", include_in_schema=False)
async def stream_audio(
    recording_id: UUID,
    ctx: Ctx,
    expires: int | None = None,
    sig: str | None = None,
    range_header: Annotated[str | None, Header(alias="Range")] = None,
) -> StreamingResponse:
    """Serve o áudio (URL assinada por `GET .../audio`), com suporte a `Range` para o player."""
    if (
        expires is None
        or not sig
        or not signature_matches(ctx.settings.secret_key, sig, "audio", recording_id, expires)
    ):
        raise unauthorized("URL de áudio inválida.")
    if expires < time.time():
        raise forbidden("URL de áudio expirada.")
    async with system_tx(ctx.engine) as conn:
        key = (await conn.execute(select(t.recordings.c.audio_key).where(t.recordings.c.id == recording_id))).scalar()
    if key is None:
        raise not_found("Gravação inexistente.")
    obj = await ctx.storage.open_range(
        key, range_header if range_header and range_header.startswith("bytes=") else None
    )
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(obj.content_length)}
    if obj.content_range:
        headers["Content-Range"] = obj.content_range
    return StreamingResponse(
        obj.chunks, status_code=206 if obj.content_range else 200, media_type=obj.content_type, headers=headers
    )


@router.post("/recordings/{recording_id}/retranscribe", status_code=202)
async def retranscribe(
    recording_id: UUID, principal: Writer, ctx: Ctx, body: RetranscribeRequest | None = None
) -> dict[str, Any]:
    """Transcreve de novo com a configuração atual; a transcrição sobe de `revision`."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        row = await lock_recording(conn, recording_id)
        if row["job_state"] in {"queued", "running"}:
            raise conflict("Já há um job de transcrição em andamento.")
        if body is not None and body.language is not None:
            await conn.execute(
                update(t.recordings).where(t.recordings.c.id == recording_id).values(language=body.language)
            )
        language = body.language if body is not None and body.language else row["language"]
        await start_next_revision(conn, row, language)
        refreshed = await get_visible(conn, recording_id)
    await next_for(ctx.engine, ctx.queue.pool, principal.user_id)
    return (await render(ctx, principal.user_id, [refreshed]))[0]


@router.post("/recordings/{recording_id}/cancel", status_code=202)
async def cancel_recording_transcription(recording_id: UUID, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Cancela a transcrição em curso ou na fila; o worker GPU para no próximo ponto de checagem."""
    row = await cancel_transcription(ctx, principal.user_id, recording_id)
    return (await render(ctx, principal.user_id, [row]))[0]


@router.post("/recordings/{recording_id}/continue")
async def continue_without_names(recording_id: UUID, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Solta a gravação parada à espera dos nomes dos locutores: a cadeia segue sem eles."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await get_visible(conn, recording_id)
        revision = await release(conn, recording_id, CONTINUED)
        if revision is None:
            raise conflict("A gravação não está esperando os nomes dos locutores.")
        refreshed = await get_visible(conn, recording_id)
    await ctx.queue.enqueue_step("detect_agenda_type", recording_id, revision)
    return (await render(ctx, principal.user_id, [refreshed]))[0]
