"""Gravações do usuário: listar, obter, editar, excluir, áudio e retranscrever."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import ColumnElement, and_, delete, exists, false, func, or_, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncConnection

from eclume_server.agenda_types import apply_type
from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.fields import mark_edited
from eclume_server.pagination import Cursor, Limit, decode_cursor, encode_cursor
from eclume_server.pipeline import current_revision
from eclume_server.problems import conflict, forbidden, invalid_field, not_found, unauthorized
from eclume_server.recordings import (
    enqueue_transcription,
    get_visible,
    recording_select,
    render,
    start_next_revision,
)
from eclume_server.routes.collections import check_collections
from eclume_server.routes.uploads import LANGUAGE, Kind
from eclume_server.security import sign, signature_matches
from eclume_server.summaries import start_auto_summary

router = APIRouter()
media_router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("recordings:read"))]
Writer = Annotated[Principal, Depends(requires("recordings:write"))]
Deleter = Annotated[Principal, Depends(requires("recordings:delete"))]
Status = Literal["uploading", "queued", "processing", "transcribed", "failed"]
Sort = Literal["created_desc", "recorded_asc", "recorded_desc"]
Many = Annotated[list[str] | None, Query()]
FIELD_FILTER = r"^([0-9a-fA-F-]{36}):(.+)$"
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


def _sort_key(sort: Sort) -> tuple[Any, bool]:
    """A coluna da ordenação e se é decrescente."""
    r = t.recordings.c
    return (r.created_at, True) if sort == "created_desc" else (r.recorded_at, sort == "recorded_desc")


def _person_filter(people: list[UUID]) -> ColumnElement[bool]:
    """Algum locutor da transcrição da gravação está ligado a uma das pessoas."""
    return exists(
        select(1)
        .select_from(t.speakers.join(t.transcripts, t.transcripts.c.id == t.speakers.c.transcript_id))
        .where(t.transcripts.c.recording_id == t.recordings.c.id, t.speakers.c.person_id.in_(people))
    )


async def _field_filters(conn: AsyncConnection, raw: list[str]) -> list[ColumnElement[bool]]:
    """Um filtro por campo (`<field_id>:<valor>`): OU entre os valores do mesmo campo.

    Título e tags são embutidos e vivem na gravação; os demais, em `field_values` (texto ou escolha
    é o valor igual; lista, um dos itens). Um campo que a conta não tem não encontra nada.
    """
    wanted: dict[UUID, list[str]] = {}
    for item in raw:
        match = re.fullmatch(FIELD_FILTER, item)
        if match is None:
            raise invalid_field("field", "use <field_id>:<valor>")
        try:
            field_id = UUID(match.group(1))
        except ValueError as exc:
            raise invalid_field("field", "field_id inválido") from exc
        wanted.setdefault(field_id, []).append(match.group(2))
    builtins = dict(
        (await conn.execute(select(t.fields.c.id, t.fields.c.builtin).where(t.fields.c.id.in_(wanted)))).all()
    )
    r, fv = t.recordings.c, t.field_values.c
    filters = []
    for field_id, values in wanted.items():
        if field_id not in builtins:
            filters.append(false())
        elif builtins[field_id] == "title":
            filters.append(r.title.in_(values))
        elif builtins[field_id] == "tags":
            filters.append(r.tags.overlap(values))
        else:
            matches = [
                or_(fv.value == func.to_jsonb(value), fv.value.contains(func.jsonb_build_array(value)))
                for value in values
            ]
            filters.append(exists(select(1).where(fv.recording_id == r.id, fv.field_id == field_id, or_(*matches))))
    return filters


@dataclass(frozen=True)
class Library:
    """Os filtros da biblioteca, como vieram na query."""

    since: datetime | None
    from_: datetime | None
    to: datetime | None
    kind: list[Kind] | None
    status: list[Status] | None
    tag: list[str] | None
    collection: list[UUID] | None
    person: list[UUID] | None

    def filters(self) -> list[ColumnElement[bool]]:
        """As condições SQL (E entre filtros; OU dentro de cada um)."""
        r = t.recordings.c
        conditions: list[ColumnElement[bool]] = []
        if self.since is not None:
            conditions.append(r.updated_at >= self.since)
        if self.from_ is not None:
            conditions.append(r.recorded_at >= self.from_)
        if self.to is not None:
            conditions.append(r.recorded_at < self.to)
        if self.kind:
            conditions.append(r.kind.in_(self.kind))
        if self.status:
            # `processing` é o `queued` com o worker já reportando progresso: filtra pelos dois e refina depois.
            conditions.append(r.status.in_({"queued" if s == "processing" else s for s in self.status}))
        if self.tag:
            conditions.append(r.tags.overlap(self.tag))
        if self.collection:
            conditions.append(r.collection_ids.overlap(self.collection))
        if self.person:
            conditions.append(_person_filter(self.person))
        return conditions


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
) -> dict[str, Any]:
    """A biblioteca: por intervalo de `recorded_at` e filtros (OU no mesmo filtro, E entre filtros)."""
    r = t.recordings.c
    key, descending = _sort_key(sort)
    order = (key.desc(), r.id.desc()) if descending else (key.asc(), r.id.asc())
    library = Library(since, from_, to, kind, status, tag, collection, person)
    query = recording_select().where(*library.filters()).order_by(*order).limit(limit + 1)
    if cursor:
        position = tuple_(key, r.id)
        after = decode_cursor(cursor)
        query = query.where(position < after if descending else position > after)
    async with user_tx(ctx.engine, principal.user_id) as conn:
        if field:
            query = query.where(and_(*await _field_filters(conn, field)))
        rows = list((await conn.execute(query)).mappings().all())
    has_more = len(rows) > limit
    rows = rows[:limit]
    items = await render(ctx, principal.user_id, rows)
    if status and {"queued", "processing"} & set(status):
        items = [item for item in items if item["status"] in status]
    next_cursor = encode_cursor(rows[-1][key.name], rows[-1]["id"]) if has_more else None
    return {"items": items, "next_cursor": next_cursor}


@router.get("/recordings/{recording_id}")
async def get_recording(recording_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Gravação e estado do job."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        row = await get_visible(conn, recording_id)
    return (await render(ctx, principal.user_id, [row]))[0]


async def _change_type(conn: AsyncConnection, recording_id: UUID, agenda_type_id: UUID | None) -> UUID | None:
    """O tipo escolhido pelo usuário: aplica título e tags e, transcrita, abre o resumo automático novo."""
    agenda_type = None
    if agenda_type_id is not None:
        agenda_type = (
            (await conn.execute(select(t.agenda_types).where(t.agenda_types.c.id == agenda_type_id))).mappings().first()
        )
        if agenda_type is None:
            raise invalid_field("agenda_type_id", "tipo de agenda inexistente ou sem acesso")
    current = (await conn.execute(select(t.recordings).where(t.recordings.c.id == recording_id))).mappings().one()
    await apply_type(conn, current, agenda_type, "edited" if agenda_type is not None else None)
    revision = await current_revision(conn, recording_id)
    if agenda_type is None or current["status"] != "transcribed" or revision is None:
        return None
    return await start_auto_summary(conn, recording_id, revision)


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
            summary_id = await _change_type(conn, recording_id, agenda_type_id)
        row = await get_visible(conn, recording_id)
    if summary_id is not None:
        await ctx.queue.enqueue_summarize(summary_id)
    return (await render(ctx, principal.user_id, [row]))[0]


@router.delete("/recordings/{recording_id}", status_code=204)
async def delete_recording(recording_id: UUID, principal: Deleter, ctx: Ctx) -> Response:
    """Exclui a gravação e tudo o que é dela: transcrição, versões do resumo, chat, marcadores e áudio.

    As FKs levam os filhos em cascata; um job ainda na fila encontra a gravação apagada e não faz nada.
    """
    async with user_tx(ctx.engine, principal.user_id) as conn:
        row = await get_visible(conn, recording_id)
        await conn.execute(delete(t.recordings).where(t.recordings.c.id == recording_id))
    await ctx.storage.delete_recording(row["audio_key"], recording_id)
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
        row = await get_visible(conn, recording_id)
        if row["job_state"] in {"queued", "running"}:
            raise conflict("Já há um job de transcrição em andamento.")
        if body is not None and body.language is not None:
            await conn.execute(
                update(t.recordings).where(t.recordings.c.id == recording_id).values(language=body.language)
            )
        language = body.language if body is not None and body.language else row["language"]
        revision, options = await start_next_revision(conn, row, language)
        refreshed = await get_visible(conn, recording_id)
    await enqueue_transcription(ctx, recording_id, revision, row["audio_key"], options)
    return (await render(ctx, principal.user_id, [refreshed]))[0]
