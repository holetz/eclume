"""Recordings: query with the most recent job, library, JSON shape and start of a transcription job."""

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
from eclume_server.speaker_naming import awaiting_condition, awaiting_of
from eclume_server.stalled import CANCELLED, is_retryable
from eclume_server.voice import keeps_samples

if TYPE_CHECKING:
    from datetime import datetime
    from uuid import UUID

    from sqlalchemy import Select
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.context import AppContext

Status = Literal["uploading", "queued", "processing", "transcribed", "failed"]
# What the recording waits for from the owner to go on (`Recording.awaiting`): today, only the speaker names.
Awaiting = Literal["speakers"]
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
    """Recordings with agenda type, most recent job, transcript and markers (under RLS).

    `owner_name` is the name of the transaction's user (`requester_name`): only they see the recordings.
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
    """Schema `Recording`, with the steps, the progress published by the GPU worker and the queue wait."""
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
    steps = pipeline_json(pipeline, (progress[0] or "asr") if progress is not None else None)
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
        "pipeline": steps,
        "awaiting": awaiting_of(steps),
        "transcript_id": str(row["transcript_id"]) if row["transcript_id"] else None,
        "marker_count": row["marker_count"],
        "audio_deleted_at": iso(row["audio_deleted_at"]),
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
    }


async def get_visible(conn: AsyncConnection, recording_id: UUID) -> Any:  # noqa: ANN401
    """The transaction user's recording (RLS only shows theirs), or 404."""
    row = (await conn.execute(recording_select().where(t.recordings.c.id == recording_id))).mappings().first()
    if row is None:
        raise not_found("Recording does not exist or is not accessible.")
    return row


async def lock_recording(conn: AsyncConnection, recording_id: UUID) -> Any:  # noqa: ANN401
    """Lock the recording row in one statement and re-read the state (job, transcript) in another, or 404.

    Every path that creates a revision goes through here before looking at the job. In separate
    statements because, under READ COMMITTED, the statement that waited for the lock sees the new
    version of the locked row only: reading together with the lock would see the old job, and two
    simultaneous requests would create two revisions. Under `user_tx`, the lock respects RLS.
    """
    locked = (
        await conn.execute(select(t.recordings.c.id).where(t.recordings.c.id == recording_id).with_for_update())
    ).scalar()
    if locked is None:
        raise not_found("Recording does not exist or is not accessible.")
    return await get_visible(conn, recording_id)


CANCELLED_MESSAGE = "Transcrição cancelada."
_OPEN = ("queued", "running")


async def cancel_open_job(conn: AsyncConnection, row: Row, progress: dict[str, str] | None) -> int | None:
    """Cancel the open job of the already locked recording (`lock_recording`); return the cancelled revision.

    Job `cancelled`, recording `failed` and the running step — preprocessing, if the revision's
    progress is in the download or in it; otherwise, transcription — `skipped` with reason `cancelled`.
    The caller asks the GPU worker to stop after the commit (`Queue.request_cancel`).
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
    """`POST /recordings/{id}/cancel`: cancel the open job (409 without one); return the recording.

    RLS decides access (404 for someone else's recording); the job changes with the connection role,
    because the user does not write to `transcription_jobs` — the same path as the worker that closes it.
    """
    async with user_tx(ctx.engine, user_id) as conn:
        await get_visible(conn, recording_id)
    progress = (await ctx.queue.raw_progress([recording_id])).get(recording_id)
    async with system_tx(ctx.engine) as conn:
        row = await lock_recording(conn, recording_id)
        revision = await cancel_open_job(conn, row, progress)
        if revision is None:
            raise conflict("There is no transcription in progress to cancel.")
    await ctx.queue.request_cancel([(recording_id, revision)])
    async with user_tx(ctx.engine, user_id) as conn:
        return await get_visible(conn, recording_id)


async def open_jobs_of(conn: AsyncConnection, owner_id: UUID) -> list[tuple[UUID, int]]:
    """`(recording, revision)` of the account's open transcription jobs, to cancel when deleting it."""
    jobs = t.transcription_jobs.c
    query = select(jobs.recording_id, jobs.revision).where(jobs.owner_id == owner_id, jobs.state.in_(_OPEN))
    return [(recording_id, revision) for recording_id, revision in await conn.execute(query)]


async def delete_recording_of(ctx: AppContext, user_id: UUID, recording_id: UUID) -> None:
    """Delete the recording and everything of it: transcript, summary versions, chat, markers and audio.

    The FKs cascade to the children, the open job included; the recording trigger puts the audio
    and `recordings/{id}/` in the bucket deletion queue in the same transaction (`storage_deletions.py`).
    After the commit, the GPU worker is told to stop and free the GPU, and a result that still
    arrives finds the recording deleted and does nothing.
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


async def account_language(conn: AsyncConnection, user_id: UUID) -> str | None:
    """The account's preferred transcription language; null is the server default."""
    query = select(t.users.c.transcription_language).where(t.users.c.id == user_id)
    return (await conn.execute(query)).scalar()


async def insert_job(
    conn: AsyncConnection,
    recording: Row,
    revision: int,
    *,
    error: tuple[str, str] | None = None,
    speakers: tuple[int | None, int | None] | None = None,
) -> None:
    """Create the revision's job, held until the account's turn (`dispatch.py`). With `error`, it is born failed.

    Speakers: the requested `speakers`; without it, the voice note (a single person) gets `(1, 1)`; the
    rest, the admin limits.
    """
    platform = (await conn.execute(select(t.platform_settings))).mappings().one()
    keep = await keeps_samples(conn, recording["owner_id"])
    # The file's language, then the account's; with neither, `transcribe_options` falls back to the server's and to `pt`.
    language = recording["language"] or await account_language(conn, recording["owner_id"])
    if speakers is None:
        kind = (await conn.execute(select(t.recordings.c.kind).where(t.recordings.c.id == recording["id"]))).scalar()
        speakers = (1, 1) if kind == "note" else None
    options = transcribe_options(platform, language, keep_samples=keep, speakers=speakers)
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
    # The audio is in the bucket: the new revision starts with received (failed, if the hash diverged).
    await set_step(conn, recording, revision, "received", "failed" if error else "done", error=error)


async def start_next_revision(
    conn: AsyncConnection,
    recording: Row,
    language: str | None,
    speakers: tuple[int | None, int | None] | None = None,
) -> int:
    """Create the next revision's job and queue the recording; return the revision.

    The revision is one above the highest of the transcript and the last job (retranscribe and retry).
    `recording` carries `id`, `owner_id`, `job_revision` and `audio_deleted_at` (the `recording_select` row).
    """
    if recording["audio_deleted_at"] is not None:
        raise conflict("The audio of this recording was deleted by the retention policy.", "audio_deleted")
    transcript_revision = (
        await conn.execute(select(t.transcripts.c.revision).where(t.transcripts.c.recording_id == recording["id"]))
    ).scalar()
    revision = max(transcript_revision or 0, recording["job_revision"] or 0) + 1
    await insert_job(
        conn,
        {"id": recording["id"], "owner_id": recording["owner_id"], "language": language},
        revision,
        speakers=speakers,
    )
    await conn.execute(
        update(t.recordings).where(t.recordings.c.id == recording["id"]).values(status="queued", updated_at=func.now())
    )
    return revision


VOCABULARY_MAX_TERMS = 50
VOCABULARY_MAX_CHARS = 400


def limit_vocabulary(names: list[str]) -> list[str]:
    """The names without repeats or blanks, in the given order, up to the term and character ceilings; a name that does not fit is skipped, the following ones still go in."""
    terms: list[str] = []
    seen: set[str] = set()
    chars = 0
    for raw in names:
        name = " ".join((raw or "").split())
        if not name or name.casefold() in seen:
            continue
        if len(terms) >= VOCABULARY_MAX_TERMS:
            break
        if chars + len(name) + 1 > VOCABULARY_MAX_CHARS:
            continue
        seen.add(name.casefold())
        terms.append(name)
        chars += len(name) + 1
    return terms


async def account_vocabulary(conn: AsyncConnection, owner_id: UUID | str) -> list[str]:
    """The names of the account's people, for ASR: filtered by owner, never from another account."""
    rows = await conn.execute(
        select(t.people.c.name).where(t.people.c.owner_id == owner_id).order_by(t.people.c.sort_name, t.people.c.id)
    )
    return limit_vocabulary([name for (name,) in rows])


async def transcribe_payload(conn: AsyncConnection, options: dict[str, Any], owner_id: UUID | str) -> dict[str, Any]:
    """The `transcribe` `options` with the encrypted HF token and the account's vocabulary (payload only)."""
    payload = dict(options)
    hf_token = await secret_encrypted(conn, HF_TOKEN)
    if hf_token:
        payload["hf_token_encrypted"] = hf_token
    if vocabulary := await account_vocabulary(conn, owner_id):
        payload["vocabulary"] = vocabulary
    return payload


# --- biblioteca ----------------------------------------------------------------------------------


def _sort_key(sort: Sort) -> tuple[Any, bool]:
    """The sort column and whether it is descending."""
    r = t.recordings.c
    return (r.created_at, True) if sort == "created_desc" else (r.recorded_at, sort == "recorded_desc")


def _person_filter(people: list[UUID]) -> ColumnElement[bool]:
    """Some speaker of the recording's transcript is linked to one of the people."""
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
    # Attributes of a single participant (a person linked to a speaker).
    person_company: list[str] | None = None
    person_department: list[str] | None = None
    person_tag: list[str] | None = None
    # `?awaiting=speakers`: the current revision paused waiting for the speaker names.
    awaiting: list[Awaiting] | None = None

    def filters(self) -> list[ColumnElement[bool]]:
        """The SQL conditions (AND between filters; OR within each one)."""
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
            # `processing` is `queued` with the worker already reporting progress: filter by both and refine later.
            conditions.append(r.status.in_({"queued" if s == "processing" else s for s in self.status}))
        if self.awaiting:
            conditions.append(awaiting_condition())
        return conditions + self._organizing()

    def _organizing(self) -> list[ColumnElement[bool]]:
        """The organization conditions: tag, collection, type, person and attributes of a participant."""
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


async def list_library(  # noqa: PLR0913 — the query, the owner and the page
    ctx: AppContext, user_id: UUID, library: Library, *, sort: Sort, cursor: str | None, limit: int
) -> dict[str, Any]:
    """A library page (schema `RecordingPage`); the cursor is valid only for the `sort` that produced it."""
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
