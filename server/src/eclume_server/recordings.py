"""Gravações: consulta com o job mais recente, biblioteca, forma JSON e início de job de transcrição."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal
from uuid import UUID

from sqlalchemy import ColumnElement, and_, delete, exists, false, func, insert, or_, select, true, tuple_, update

from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.pagination import decode_cursor, encode_cursor, iso
from eclume_server.pipeline import load_pipelines, pipeline_json, set_step
from eclume_server.problems import invalid_field, not_found
from eclume_server.queue import transcribe_options
from eclume_server.serialize import Row, user_ref
from eclume_server.settings_admin import HF_TOKEN, secret_encrypted
from eclume_server.stalled import is_retryable

if TYPE_CHECKING:
    from datetime import datetime

    from sqlalchemy import Select
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.context import AppContext

Status = Literal["uploading", "queued", "processing", "transcribed", "failed"]
Sort = Literal["created_desc", "recorded_asc", "recorded_desc"]
FIELD_FILTER = r"^([0-9a-fA-F-]{36}):(.+)$"

_job = (
    select(t.transcription_jobs)
    .where(t.transcription_jobs.c.recording_id == t.recordings.c.id)
    .order_by(t.transcription_jobs.c.revision.desc())
    .limit(1)
    .lateral("job")
)
_markers = (
    select(func.count().label("marker_count")).where(t.markers.c.recording_id == t.recordings.c.id).lateral("markers")
)


def recording_select() -> Select:
    """Gravações com dono, tipo de agenda, job mais recente, transcrição e marcadores (sob a RLS)."""
    return select(
        t.recordings,
        t.users.c.name.label("owner_name"),
        t.agenda_types.c.name.label("agenda_type_name"),
        t.transcripts.c.id.label("transcript_id"),
        _markers.c.marker_count,
        *(column.label(f"job_{column.name}") for column in _job.c),
    ).select_from(
        t.recordings.join(t.users, t.users.c.id == t.recordings.c.owner_id)
        .outerjoin(t.agenda_types, t.agenda_types.c.id == t.recordings.c.agenda_type_id)
        .outerjoin(_job, true())
        .outerjoin(t.transcripts, t.transcripts.c.recording_id == t.recordings.c.id)
        .join(_markers, true())
    )


def _job_json(row: Row, progress: tuple[str | None, float] | None) -> dict[str, Any] | None:
    if row["job_id"] is None:
        return None
    state = row["job_state"]
    stage = None
    value = 1.0 if state == "succeeded" else 0.0
    if state in {"queued", "running"} and progress is not None:
        state = "running"
        stage, value = progress
    error = None
    if row["job_error_code"]:
        error = {
            "code": row["job_error_code"],
            "message": row["job_error_message"] or "",
            "retryable": is_retryable(row["job_error_code"]),
        }
    return {
        "id": str(row["job_id"]),
        "state": state,
        "stage": stage,
        "progress": value,
        "attempts": row["job_attempts"],
        "error": error,
        "queued_at": iso(row["job_queued_at"]),
        "started_at": iso(row["job_started_at"]),
        "finished_at": iso(row["job_finished_at"]),
    }


def recording_json(row: Row, pipeline: list[Row], progress: tuple[str | None, float] | None = None) -> dict[str, Any]:
    """Schema `Recording`, com as etapas e o progresso em curso publicado pelo worker GPU."""
    job = _job_json(row, progress)
    agenda_type = None
    if row["agenda_type_id"] is not None:
        agenda_type = {
            "id": str(row["agenda_type_id"]),
            "name": row["agenda_type_name"],
            "origin": row["agenda_type_origin"],
        }
    status = row["status"]
    if status == "queued" and job is not None and job["state"] == "running":
        status = "processing"
    return {
        "id": str(row["id"]),
        "title": row["title"],
        "status": status,
        "kind": row["kind"],
        "source": row["source"],
        "recorded_at": iso(row["recorded_at"]),
        "recorded_at_source": row["recorded_at_source"],
        "duration_ms": row["duration_ms"],
        "language": row["language"],
        "size_bytes": row["size_bytes"],
        "content_type": row["content_type"],
        "content_hash": row["content_hash"],
        "owner": user_ref(row["owner_id"], row["owner_name"]),
        "tags": list(row["tags"]),
        "collection_ids": [str(c) for c in row["collection_ids"]],
        "metadata": row["metadata"],
        "capture": row["capture"],
        "agenda_type": agenda_type,
        "job": job,
        "pipeline": pipeline_json(pipeline, (progress[0] or "asr") if progress is not None else None),
        "transcript_id": str(row["transcript_id"]) if row["transcript_id"] else None,
        "marker_count": row["marker_count"],
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
    }


async def get_visible(conn: AsyncConnection, recording_id: UUID) -> Any:  # noqa: ANN401
    """Gravação do usuário da transação (a RLS só mostra as dele), ou 404."""
    row = (await conn.execute(recording_select().where(t.recordings.c.id == recording_id))).mappings().first()
    if row is None:
        raise not_found("Gravação inexistente ou sem acesso.")
    return row


async def delete_recording_of(ctx: AppContext, user_id: UUID, recording_id: UUID) -> None:
    """Exclui a gravação e tudo o que é dela: transcrição, versões do resumo, chat, marcadores e áudio.

    As FKs levam os filhos em cascata; um job ainda na fila encontra a gravação apagada e não faz nada.
    """
    async with user_tx(ctx.engine, user_id) as conn:
        row = await get_visible(conn, recording_id)
        await conn.execute(delete(t.recordings).where(t.recordings.c.id == recording_id))
    await ctx.storage.delete_recording(row["audio_key"], recording_id)


async def render(ctx: AppContext, user_id: UUID, rows: list[Row]) -> list[dict[str, Any]]:
    """Formas JSON, com as etapas do pipeline e o progresso do Redis para os jobs em aberto."""
    open_jobs = [row["id"] for row in rows if row["job_state"] in {"queued", "running"}]
    progress = await ctx.queue.progress(open_jobs)
    async with user_tx(ctx.engine, user_id) as conn:
        pipelines = await load_pipelines(conn, [row["id"] for row in rows])
    return [recording_json(row, pipelines.get(row["id"], []), progress.get(row["id"])) for row in rows]


async def insert_job(
    conn: AsyncConnection,
    recording: Row,
    revision: int,
    *,
    error: tuple[str, str] | None = None,
) -> dict[str, Any]:
    """Cria o job da revisão; devolve as `options` do `transcribe`. Com `error`, nasce falho."""
    platform = (await conn.execute(select(t.platform_settings))).mappings().one()
    options = transcribe_options(platform, recording["language"])
    values: dict[str, Any] = {
        "owner_id": recording["owner_id"],
        "recording_id": recording["id"],
        "revision": revision,
        "state": "queued",
        "options": options,
    }
    if error is not None:
        values |= {"state": "failed", "error_code": error[0], "error_message": error[1], "finished_at": func.now()}
    await conn.execute(insert(t.transcription_jobs).values(**values))
    # O áudio está no bucket: a revisão nova começa com o recebido (falho, se o hash divergiu).
    await set_step(conn, recording, revision, "received", "failed" if error else "done", error=error)
    return options


async def start_next_revision(
    conn: AsyncConnection, recording: Row, language: str | None
) -> tuple[int, dict[str, Any]]:
    """Cria o job da revisão seguinte e põe a gravação na fila; devolve `(revisão, options)`.

    A revisão é uma acima da maior entre a transcrição e o último job (retranscrever e retentar).
    `recording` traz `id`, `owner_id` e `job_revision` (a linha de `recording_select`).
    """
    transcript_revision = (
        await conn.execute(select(t.transcripts.c.revision).where(t.transcripts.c.recording_id == recording["id"]))
    ).scalar()
    revision = max(transcript_revision or 0, recording["job_revision"] or 0) + 1
    options = await insert_job(
        conn, {"id": recording["id"], "owner_id": recording["owner_id"], "language": language}, revision
    )
    await conn.execute(
        update(t.recordings).where(t.recordings.c.id == recording["id"]).values(status="queued", updated_at=func.now())
    )
    return revision, options


async def enqueue_transcription(
    ctx: AppContext, recording_id: UUID, revision: int, audio_key: str, options: dict[str, Any]
) -> None:
    """Enfileira o `transcribe`; o token do HF da plataforma vai cifrado só no payload do job.

    O texto cifrado não entra em `transcription_jobs.options`: o worker o abre com a mesma chave de
    cifra do server (docs/standards/api/jobs-transcricao.md).
    """
    async with system_tx(ctx.engine) as conn:
        hf_token = await secret_encrypted(conn, HF_TOKEN)
    payload = {**options, "hf_token_encrypted": hf_token} if hf_token else options
    await ctx.queue.enqueue_transcribe(recording_id, revision, audio_key, payload)


# --- biblioteca ----------------------------------------------------------------------------------


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
    kind: list[str] | None
    status: list[Status] | None
    tag: list[str] | None
    collection: list[UUID] | None
    person: list[UUID] | None
    field: list[str] | None = None
    agenda_type: list[UUID] | None = None

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
        if self.agenda_type:
            conditions.append(r.agenda_type_id.in_(self.agenda_type))
        return conditions


async def list_library(  # noqa: PLR0913 — a consulta, o dono e a página
    ctx: AppContext, user_id: UUID, library: Library, *, sort: Sort, cursor: str | None, limit: int
) -> dict[str, Any]:
    """Uma página da biblioteca (schema `RecordingPage`); o cursor vale só para o `sort` que o gerou."""
    r = t.recordings.c
    key, descending = _sort_key(sort)
    order = (key.desc(), r.id.desc()) if descending else (key.asc(), r.id.asc())
    query = recording_select().where(*library.filters()).order_by(*order).limit(limit + 1)
    if cursor:
        position = tuple_(key, r.id)
        after = decode_cursor(cursor)
        query = query.where(position < after if descending else position > after)
    async with user_tx(ctx.engine, user_id) as conn:
        if library.field:
            query = query.where(and_(*await _field_filters(conn, library.field)))
        rows = list((await conn.execute(query)).mappings().all())
    has_more = len(rows) > limit
    rows = rows[:limit]
    items = await render(ctx, user_id, rows)
    if library.status and {"queued", "processing"} & set(library.status):
        items = [item for item in items if item["status"] in library.status]
    next_cursor = encode_cursor(rows[-1][key.name], rows[-1]["id"]) if has_more else None
    return {"items": items, "next_cursor": next_cursor}
