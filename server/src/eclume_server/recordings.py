"""Gravações: consulta com o job mais recente, biblioteca, forma JSON e início de job de transcrição."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from sqlalchemy import ColumnElement, and_, delete, exists, func, insert, select, true, tuple_, update

from eclume_server import queue_status
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.fields import field_filters
from eclume_server.pagination import decode_cursor, encode_cursor, iso
from eclume_server.people import attribute_conditions, participant_filter
from eclume_server.pipeline import FAILED_STEP, load_pipelines, pipeline_json, set_step
from eclume_server.problems import conflict, not_found
from eclume_server.queue import progress_of_revision, transcribe_options
from eclume_server.serialize import Row, requester_name, user_ref
from eclume_server.settings_admin import HF_TOKEN, secret_encrypted
from eclume_server.stalled import CANCELLED, is_retryable
from eclume_server.voice import keeps_samples

if TYPE_CHECKING:
    from datetime import datetime
    from uuid import UUID

    from sqlalchemy import Select
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.context import AppContext

Status = Literal["uploading", "queued", "processing", "transcribed", "failed"]
Sort = Literal["created_desc", "recorded_asc", "recorded_desc"]

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
    """Gravações com tipo de agenda, job mais recente, transcrição e marcadores (sob a RLS).

    `owner_name` é o nome do usuário da transação (`requester_name`): só ele vê as gravações.
    """
    return select(
        t.recordings,
        requester_name().label("owner_name"),
        t.agenda_types.c.name.label("agenda_type_name"),
        t.transcripts.c.id.label("transcript_id"),
        _markers.c.marker_count,
        *(column.label(f"job_{column.name}") for column in _job.c),
    ).select_from(
        t.recordings.outerjoin(t.agenda_types, t.agenda_types.c.id == t.recordings.c.agenda_type_id)
        .outerjoin(_job, true())
        .outerjoin(t.transcripts, t.transcripts.c.recording_id == t.recordings.c.id)
        .join(_markers, true())
    )


def _job_json(
    row: Row, progress: tuple[str | None, float] | None, queue: dict[str, Any] | None
) -> dict[str, Any] | None:
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
        "queue": queue if state == "queued" else None,
    }


def recording_json(
    row: Row,
    pipeline: list[Row],
    progress: tuple[str | None, float] | None = None,
    queue: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Schema `Recording`, com as etapas, o progresso publicado pelo worker GPU e a espera na fila."""
    job = _job_json(row, progress, queue)
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
        "collections_origin": row["collections_origin"],
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


async def lock_recording(conn: AsyncConnection, recording_id: UUID) -> Any:  # noqa: ANN401
    """Trava a linha da gravação num comando e relê o estado (job, transcrição) em outro, ou 404.

    Todo caminho que cria uma revisão passa por aqui antes de olhar o job. Em comandos separados
    porque, em READ COMMITTED, o comando que esperou o lock vê a versão nova só da linha travada:
    a leitura junto da trava veria o job antigo, e dois pedidos simultâneos criariam duas revisões.
    Sob `user_tx`, a trava respeita a RLS.
    """
    locked = (
        await conn.execute(select(t.recordings.c.id).where(t.recordings.c.id == recording_id).with_for_update())
    ).scalar()
    if locked is None:
        raise not_found("Gravação inexistente ou sem acesso.")
    return await get_visible(conn, recording_id)


CANCELLED_MESSAGE = "Transcrição cancelada."
_OPEN = ("queued", "running")


async def cancel_open_job(conn: AsyncConnection, row: Row, progress: dict[str, str] | None) -> int | None:
    """Cancela o job em aberto da gravação já travada (`lock_recording`); devolve a revisão cancelada.

    Job `cancelled`, gravação `failed` e a etapa em curso — o pré-processamento, se o progresso da
    revisão está no download ou nele; senão, a transcrição — `skipped` com o motivo `cancelled`.
    Quem chama pede a parada ao worker GPU depois do commit (`Queue.request_cancel`).
    """
    if row["job_state"] not in _OPEN:
        return None
    revision = row["job_revision"]
    raw = progress_of_revision(progress, revision)
    jobs = t.transcription_jobs
    await conn.execute(
        update(jobs)
        .where(jobs.c.id == row["job_id"])
        .values(state=CANCELLED, error_code=CANCELLED, error_message=CANCELLED_MESSAGE, finished_at=func.now())
    )
    await conn.execute(
        update(t.recordings).where(t.recordings.c.id == row["id"]).values(status="failed", updated_at=func.now())
    )
    step = FAILED_STEP.get((raw or {}).get("stage", ""), "transcription")
    await set_step(conn, row, revision, step, "skipped", detail={"reason": CANCELLED})
    return revision


async def cancel_transcription(ctx: AppContext, user_id: UUID, recording_id: UUID) -> Any:  # noqa: ANN401
    """`POST /recordings/{id}/cancel`: cancela o job em aberto (409 sem ele); devolve a gravação.

    A RLS decide o acesso (404 para a gravação de outro); o job muda com o papel de conexão, porque
    o usuário não escreve em `transcription_jobs` — o mesmo caminho do worker que o fecha.
    """
    async with user_tx(ctx.engine, user_id) as conn:
        await get_visible(conn, recording_id)
    progress = (await ctx.queue.raw_progress([recording_id])).get(recording_id)
    async with system_tx(ctx.engine) as conn:
        row = await lock_recording(conn, recording_id)
        revision = await cancel_open_job(conn, row, progress)
        if revision is None:
            raise conflict("Não há transcrição em andamento para cancelar.")
    await ctx.queue.request_cancel([(recording_id, revision)])
    async with user_tx(ctx.engine, user_id) as conn:
        return await get_visible(conn, recording_id)


async def open_jobs_of(conn: AsyncConnection, owner_id: UUID) -> list[tuple[UUID, int]]:
    """`(gravação, revisão)` dos jobs de transcrição em aberto da conta, para cancelar ao excluí-la."""
    jobs = t.transcription_jobs.c
    query = select(jobs.recording_id, jobs.revision).where(jobs.owner_id == owner_id, jobs.state.in_(_OPEN))
    return [(recording_id, revision) for recording_id, revision in await conn.execute(query)]


async def delete_recording_of(ctx: AppContext, user_id: UUID, recording_id: UUID) -> None:
    """Exclui a gravação e tudo o que é dela: transcrição, versões do resumo, chat, marcadores e áudio.

    As FKs levam os filhos em cascata, o job em aberto inclusive; o gatilho da gravação põe o áudio
    e `recordings/{id}/` na fila de exclusão do bucket na mesma transação (`storage_deletions.py`).
    Depois do commit, o worker GPU é avisado para parar e liberar a GPU, e um resultado que ainda
    chegue encontra a gravação apagada e não faz nada.
    """
    async with user_tx(ctx.engine, user_id) as conn:
        row = await lock_recording(conn, recording_id)
        await conn.execute(delete(t.recordings).where(t.recordings.c.id == recording_id))
    if row["job_state"] in _OPEN:
        await ctx.queue.request_cancel([(recording_id, row["job_revision"])])


async def render(ctx: AppContext, user_id: UUID, rows: list[Row]) -> list[dict[str, Any]]:
    """Formas JSON, com as etapas do pipeline, o progresso do Redis e a espera dos jobs em aberto."""
    open_jobs = {row["id"]: row["job_revision"] for row in rows if row["job_state"] in {"queued", "running"}}
    progress = await ctx.queue.progress(open_jobs)
    waiting = [row for row in rows if row["job_state"] == "queued" and row["id"] not in progress]
    queues = await queue_status.waiting(ctx.engine, ctx.queue, waiting)
    async with user_tx(ctx.engine, user_id) as conn:
        pipelines = await load_pipelines(conn, [row["id"] for row in rows])
    return [
        recording_json(row, pipelines.get(row["id"], []), progress.get(row["id"]), queues.get(row["id"]))
        for row in rows
    ]


async def insert_job(
    conn: AsyncConnection,
    recording: Row,
    revision: int,
    *,
    error: tuple[str, str] | None = None,
) -> None:
    """Cria o job da revisão, retido até a vez da conta (`dispatch.py`). Com `error`, nasce falho."""
    platform = (await conn.execute(select(t.platform_settings))).mappings().one()
    keep = await keeps_samples(conn, recording["owner_id"])
    options = transcribe_options(platform, recording["language"], keep_samples=keep)
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


async def start_next_revision(conn: AsyncConnection, recording: Row, language: str | None) -> int:
    """Cria o job da revisão seguinte e põe a gravação na fila; devolve a revisão.

    A revisão é uma acima da maior entre a transcrição e o último job (retranscrever e retentar).
    `recording` traz `id`, `owner_id` e `job_revision` (a linha de `recording_select`).
    """
    transcript_revision = (
        await conn.execute(select(t.transcripts.c.revision).where(t.transcripts.c.recording_id == recording["id"]))
    ).scalar()
    revision = max(transcript_revision or 0, recording["job_revision"] or 0) + 1
    await insert_job(conn, {"id": recording["id"], "owner_id": recording["owner_id"], "language": language}, revision)
    await conn.execute(
        update(t.recordings).where(t.recordings.c.id == recording["id"]).values(status="queued", updated_at=func.now())
    )
    return revision


async def transcribe_payload(conn: AsyncConnection, options: dict[str, Any]) -> dict[str, Any]:
    """As `options` do `transcribe` com o token do HF da plataforma cifrado (papel de conexão)."""
    hf_token = await secret_encrypted(conn, HF_TOKEN)
    return {**options, "hf_token_encrypted": hf_token} if hf_token else options


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
    # Atributos de um mesmo participante (pessoa ligada a um locutor).
    person_company: list[str] | None = None
    person_department: list[str] | None = None
    person_tag: list[str] | None = None

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
        return conditions + self._organizing()

    def _organizing(self) -> list[ColumnElement[bool]]:
        """As condições de organização: tag, coleção, tipo, pessoa e atributos de um participante."""
        r = t.recordings.c
        conditions: list[ColumnElement[bool]] = []
        if self.tag:
            conditions.append(r.tags.overlap(self.tag))
        if self.collection:
            conditions.append(r.collection_ids.overlap(self.collection))
        if self.person:
            conditions.append(_person_filter(self.person))
        if self.agenda_type:
            conditions.append(r.agenda_type_id.in_(self.agenda_type))
        participant = attribute_conditions(self.person_company, self.person_department, self.person_tag)
        if participant:
            conditions.append(participant_filter(participant))
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
            query = query.where(and_(*await field_filters(conn, library.field)))
        rows = list((await conn.execute(query)).mappings().all())
    has_more = len(rows) > limit
    rows = rows[:limit]
    items = await render(ctx, user_id, rows)
    if library.status and {"queued", "processing"} & set(library.status):
        items = [item for item in items if item["status"] in library.status]
    next_cursor = encode_cursor(rows[-1][key.name], rows[-1]["id"]) if has_more else None
    return {"items": items, "next_cursor": next_cursor}
