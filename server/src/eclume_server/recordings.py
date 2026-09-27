"""Gravações: consulta com o job mais recente, forma JSON e início de job de transcrição."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import func, insert, select, true, update

from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.pagination import iso
from eclume_server.pipeline import load_pipelines, pipeline_json, set_step
from eclume_server.problems import not_found
from eclume_server.queue import transcribe_options
from eclume_server.serialize import Row, user_ref
from eclume_server.settings_admin import HF_TOKEN, secret_encrypted
from eclume_server.stalled import is_retryable

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy import Select
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.context import AppContext

_job = (
    select(t.transcription_jobs)
    .where(t.transcription_jobs.c.recording_id == t.recordings.c.id)
    .order_by(t.transcription_jobs.c.revision.desc())
    .limit(1)
    .lateral("job")
)


def recording_select() -> Select:
    """Gravações com dono, tipo de agenda, job mais recente e transcrição (sob a RLS)."""
    return select(
        t.recordings,
        t.users.c.name.label("owner_name"),
        t.agenda_types.c.name.label("agenda_type_name"),
        t.transcripts.c.id.label("transcript_id"),
        *(column.label(f"job_{column.name}") for column in _job.c),
    ).select_from(
        t.recordings.join(t.users, t.users.c.id == t.recordings.c.owner_id)
        .outerjoin(t.agenda_types, t.agenda_types.c.id == t.recordings.c.agenda_type_id)
        .outerjoin(_job, true())
        .outerjoin(t.transcripts, t.transcripts.c.recording_id == t.recordings.c.id)
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
        "source": row["source"],
        "recorded_at": iso(row["recorded_at"]),
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
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
    }


async def get_visible(conn: AsyncConnection, recording_id: UUID) -> Any:  # noqa: ANN401
    """Gravação do usuário da transação (a RLS só mostra as dele), ou 404."""
    row = (await conn.execute(recording_select().where(t.recordings.c.id == recording_id))).mappings().first()
    if row is None:
        raise not_found("Gravação inexistente ou sem acesso.")
    return row


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
