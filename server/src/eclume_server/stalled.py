"""Dead transcription job detection: the server notices what the GPU worker could not report.

With `max_tries=1`, a GPU worker that dies in the middle of a `transcribe` (OOM kill, restart,
deploy) does not enqueue `transcription_failed`, and the recording would stay `processing` forever.
The CPU worker's `reap_stalled_jobs` cron crosses three signals per open job — the state in arq,
the progress hash of the job's revision and the GPU worker heartbeat (`busy` and the current
`job_id`) — and marks as a **recoverable** failure whatever nobody is left to finish — including a
finished `transcribe` whose ingestion never arrived (`ingest_failed`).
Rules in docs/standards/api/jobs-transcricao.md `§Job morto`.

A `transcribe` whose enqueueing was lost (job `queued` in the database, gone from arq, no progress)
goes back to the queue once before becoming `job_lost`: it never ran, so it does not repeat an OOM
or bad audio. The mark `eclume:reaper:requeued:<_job_id>` (7 days) prevents a second round.

Nothing is marked the first time it looks dead: the suspicion is recorded in Redis and only becomes
a failure if it stays the same after the grace period (`job_grace_seconds`), which covers the worker
that just picked up the job and has not yet published progress or a heartbeat.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from arq.jobs import DeserializationError, Job, JobResult, JobStatus
from sqlalchemy import select

from eclume_engines.fila import desserializar
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.queue import (
    GPU_HEALTH_KEY,
    GPU_LAST_SEEN_KEY,
    GPU_QUEUE,
    progress_key,
    progress_of_revision,
    transcribe_job_id,
)
from eclume_server.transcripts import fail

if TYPE_CHECKING:
    from uuid import UUID

    from arq.connections import ArqRedis
    from sqlalchemy.ext.asyncio import AsyncEngine

    from eclume_server.config import Settings

log = logging.getLogger(__name__)

WORKER_LOST = "worker_lost"
JOB_LOST = "job_lost"
JOB_STALLED = "job_stalled"
# The transcript was ready on the GPU worker, but ingestion on the CPU worker failed or never happened.
INGEST_FAILED = "ingest_failed"
INGEST_FAILED_MESSAGE = "A transcrição ficou pronta, mas não foi possível gravá-la. Tente de novo."
# The owner cancelled the transcription (or deleted the recording): job state and error code.
CANCELLED = "cancelled"
# Transient failures: retrying (retranscribe or `POST /admin/jobs/{id}/retry`) tends to solve them.
RETRYABLE_CODES = frozenset(
    {
        WORKER_LOST,
        JOB_LOST,
        JOB_STALLED,
        INGEST_FAILED,
        CANCELLED,
        "gpu_oom",
        "out_of_memory",
        "audio_download_failed",
        "upload_failed",
    }
)
_MESSAGES = {
    WORKER_LOST: "O worker de transcrição parou no meio do job. Tente de novo.",
    JOB_LOST: "O job de transcrição sumiu da fila sem resposta. Tente de novo.",
    JOB_STALLED: "A transcrição ficou parada, sem progresso, além do tempo máximo. Tente de novo.",
    INGEST_FAILED: INGEST_FAILED_MESSAGE,
}
_SUSPECT_PREFIX = "eclume:reaper:suspect:"
_REQUEUED_PREFIX = "eclume:reaper:requeued:"
REQUEUED_TTL_S = 7 * 24 * 3600
REQUEUED = "requeued"


def is_retryable(code: str | None) -> bool:
    """Whether the failure with code `code` is transient."""
    return code in RETRYABLE_CODES


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _decode(values: dict[Any, Any]) -> dict[str, str]:
    return {
        (k.decode() if isinstance(k, bytes) else k): (v.decode() if isinstance(v, bytes) else v)
        for k, v in values.items()
    }


async def _diagnose_complete(job: Job, *, now: datetime, settings: Settings) -> str | None:
    """The `transcribe` finished in arq, but the job is still open in the database."""
    try:
        result: JobResult | None = await job.result_info()
    except DeserializationError:
        # A pickled result holding an object (the exception of a job that blew up in arq) is refused
        # by the globals-free unpickler: `transcribe` always returns a dict, so it is a failure.
        return WORKER_LOST
    if result is None:
        return None
    # Failure in arq: the worker died and arq's retry (max_tries=1) ended the job without
    # `transcription_failed`.
    if not result.success:
        return WORKER_LOST
    # Success: ingestion may be in the `eclume:default` queue; past the ceiling, it no longer is (a
    # failing one already marks `ingest_failed` on its own; this covers the one that got lost).
    finished = result.finish_time if result.finish_time.tzinfo else result.finish_time.replace(tzinfo=UTC)
    return INGEST_FAILED if now - finished > timedelta(seconds=settings.job_stall_seconds) else None


def _worker_on(beat: dict[str, str] | None, job_id: str) -> bool:
    """The live worker declares it is running this job (without `job_id` in the heartbeat, an old worker, `busy` is enough)."""
    return beat is not None and beat.get("busy") == "1" and beat.get("job_id", job_id) == job_id


async def diagnose(  # noqa: PLR0913 — the three signals and the clock are explicit, for the test
    redis: ArqRedis,
    job_id: str,
    *,
    recording_id: UUID,
    revision: int,
    beat: dict[str, str] | None,
    now: datetime,
    settings: Settings,
) -> str | None:
    """The failure code the job deserves now, or `None` if someone is still there to finish it."""
    job = Job(job_id, redis, _queue_name=GPU_QUEUE, _deserializer=desserializar)
    status = await job.status()
    if status in {JobStatus.queued, JobStatus.deferred}:
        return None  # a delayed queue is not a failure
    if status == JobStatus.complete:
        return await _diagnose_complete(job, now=now, settings=settings)

    # Progress of another revision says nothing about this job.
    progress = progress_of_revision(_decode(await redis.hgetall(progress_key(recording_id))), revision) or {}
    if status == JobStatus.not_found and not progress:
        return JOB_LOST
    updated = _parse(progress.get("updated_at"))
    if updated is not None and now - updated > timedelta(seconds=settings.job_stall_seconds):
        return JOB_STALLED
    silent = updated is None or now - updated > timedelta(seconds=settings.job_grace_seconds)
    if silent and not _worker_on(beat, job_id):
        return WORKER_LOST
    return None


async def _confirmed(redis: ArqRedis, job_key: str, code: str | None, now: datetime, grace: float) -> bool:
    """Record the suspicion; confirm only one that lasts the whole grace period with the same diagnosis."""
    key = _SUSPECT_PREFIX + job_key
    if code is None:
        await redis.delete(key)
        return False
    raw = await redis.get(key)
    first = raw.decode() if isinstance(raw, bytes) else raw
    if first is None or not first.startswith(f"{code}|"):
        await redis.set(key, f"{code}|{now.timestamp()}", ex=int(grace * 10) + 60)
        return False
    since = datetime.fromtimestamp(float(first.split("|", 1)[1]), UTC)
    if now - since < timedelta(seconds=grace):
        return False
    await redis.delete(key)
    return True


async def _requeue_once(
    engine: AsyncEngine, redis: ArqRedis, recording_id: UUID, job_key: str, options: dict[str, Any] | None
) -> bool:
    """Re-enqueue the lost `transcribe`, if it has not gone back once yet; tell whether it re-enqueued."""
    # `recordings` imports from here (`is_retryable`): the import stays inside the function.
    from eclume_server.recordings import transcribe_payload  # noqa: PLC0415

    if not await redis.set(_REQUEUED_PREFIX + job_key, "1", ex=REQUEUED_TTL_S, nx=True):
        return False
    async with system_tx(engine) as conn:
        found = (
            await conn.execute(
                select(t.recordings.c.audio_key, t.recordings.c.owner_id).where(t.recordings.c.id == recording_id)
            )
        ).first()
        if found is None or found[0] is None:
            return False
        audio_key, owner_id = found
        payload = await transcribe_payload(conn, options or {}, owner_id)
    await redis.enqueue_job("transcribe", str(recording_id), audio_key, payload, _job_id=job_key, _queue_name=GPU_QUEUE)
    return True


async def reap(engine: AsyncEngine, redis: ArqRedis, settings: Settings, now: datetime | None = None) -> list[str]:
    """Mark as a recoverable failure the jobs nobody will finish; return what it marked, for the log."""
    now = now or datetime.now(UTC)
    grace = timedelta(seconds=settings.job_grace_seconds)
    raw_beat = await redis.hgetall(GPU_HEALTH_KEY)
    beat = _decode(raw_beat) if raw_beat else None
    # The last seen, before looking at the jobs: it is the wait's "down since" (`queue_status.py`).
    if beat is not None and beat.get("updated_at"):
        await redis.set(GPU_LAST_SEEN_KEY, beat["updated_at"])
    jobs = t.transcription_jobs
    async with system_tx(engine) as conn:
        rows = (
            await conn.execute(
                select(jobs.c.id, jobs.c.recording_id, jobs.c.revision, jobs.c.state, jobs.c.options).where(
                    # A held job (not dispatched) waits for the account's turn in the database: it is not dead.
                    jobs.c.state.in_(["queued", "running"]),
                    jobs.c.dispatched_at <= now - grace,
                )
            )
        ).all()
    if not rows:
        return []
    reaped = []
    for job_row_id, recording_id, revision, state, options in rows:
        job_key = transcribe_job_id(recording_id, revision)
        code = await diagnose(
            redis, job_key, recording_id=recording_id, revision=revision, beat=beat, now=now, settings=settings
        )
        if not await _confirmed(redis, job_key, code, now, settings.job_grace_seconds):
            continue
        if (
            code == JOB_LOST
            and state == "queued"
            and await _requeue_once(engine, redis, recording_id, job_key, options)
        ):
            log.warning(
                "job %s (recording %s): transcribe lost before running; back in the queue", job_row_id, recording_id
            )
            reaped.append(f"{recording_id}: {REQUEUED}")
            continue
        async with system_tx(engine) as conn:
            result = await fail(conn, recording_id, code, _MESSAGES[code], revision=revision)
        if not result.closed:
            continue
        await redis.delete(progress_key(recording_id))
        log.warning("job %s (recording %s): %s — %s", job_row_id, recording_id, code, result.message)
        reaped.append(f"{recording_id}: {code}")
    return reaped
