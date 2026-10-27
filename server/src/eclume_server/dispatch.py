"""Per-account turn dispatch: the GPU's fair queue without touching arq.

Each account has at most one `transcribe` in `eclume:gpu`. The job is born `queued` without
`dispatched_at` (held in the database); `next_for` marks and enqueues it when the account has no
other open dispatched job and is still within its 24 h GPU minutes. With one job per account in
arq's FIFO queue, the round-robin between accounts comes for free. Callers: the upload's
`complete`, retranscribe, the admin retry, ingestion and the `transcribe` failure, and the
`dispatch_waiting` cron as a safety net. Rules in docs/standards/api/jobs-transcricao.md `§Filas`.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from sqlalchemy import func, select, update

from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.queue import GPU_QUEUE, transcribe_job_id
from eclume_server.quotas import within_gpu_minutes
from eclume_server.recordings import transcribe_payload

if TYPE_CHECKING:
    from uuid import UUID

    from arq.connections import ArqRedis
    from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

log = logging.getLogger(__name__)

# First key of the dispatch's `pg_advisory_xact_lock(int, int)`; the second is the account.
_LOCK_CLASS = 98
_OPEN = ("queued", "running")


def _jobs_open(owner_id: UUID) -> list:
    jobs = t.transcription_jobs.c
    return [jobs.owner_id == owner_id, jobs.state.in_(_OPEN)]


async def _lock(conn: AsyncConnection, owner_id: UUID) -> None:
    await conn.execute(select(func.pg_advisory_xact_lock(_LOCK_CLASS, func.hashtext(str(owner_id)))))


async def next_for(engine: AsyncEngine, redis: ArqRedis, owner_id: UUID) -> UUID | None:
    """Dispatch the account's oldest held job, if it is its turn; return the dispatched recording.

    Enqueueing comes after the commit: if it is lost, the dispatched job is left without arq and the
    reaper puts it back in the queue once (`stalled.py`).
    """
    jobs = t.transcription_jobs
    async with system_tx(engine) as conn:
        await _lock(conn, owner_id)
        busy = (
            await conn.execute(select(jobs.c.id).where(*_jobs_open(owner_id), jobs.c.dispatched_at.is_not(None)))
        ).first()
        if busy is not None:
            return None
        waiting = (
            (
                await conn.execute(
                    select(jobs.c.id, jobs.c.recording_id, jobs.c.revision, jobs.c.options, t.recordings.c.audio_key)
                    .join(t.recordings, t.recordings.c.id == jobs.c.recording_id)
                    .where(jobs.c.owner_id == owner_id, jobs.c.state == "queued", jobs.c.dispatched_at.is_(None))
                    .order_by(jobs.c.queued_at, jobs.c.id)
                    .limit(1)
                )
            )
            .mappings()
            .first()
        )
        if waiting is None or not await within_gpu_minutes(conn, owner_id):
            return None
        await conn.execute(update(jobs).where(jobs.c.id == waiting["id"]).values(dispatched_at=func.now()))
        payload = await transcribe_payload(conn, waiting["options"] or {}, owner_id)
    recording_id = waiting["recording_id"]
    await redis.enqueue_job(
        "transcribe",
        str(recording_id),
        waiting["audio_key"],
        payload,
        _job_id=transcribe_job_id(recording_id, waiting["revision"]),
        _queue_name=GPU_QUEUE,
    )
    return recording_id


async def next_for_recording(engine: AsyncEngine, redis: ArqRedis, recording_id: UUID | str) -> UUID | None:
    """`next_for` of the account that owns the recording (ingestion and failure only know the recording)."""
    async with system_tx(engine) as conn:
        owner_id = (
            await conn.execute(select(t.recordings.c.owner_id).where(t.recordings.c.id == recording_id))
        ).scalar()
    return None if owner_id is None else await next_for(engine, redis, owner_id)


async def held_counts(conn: AsyncConnection) -> dict[str, int]:
    """Held jobs (numbers only): those awaiting the account's turn and those awaiting the minutes window.

    A held job of an account with no dispatched job and within its minutes counts as on the
    account's turn: the next dispatch (or the cron) takes it.
    """
    jobs = t.transcription_jobs.c
    held = {"account_turn": 0, "gpu_minutes": 0}
    rows = await conn.execute(
        select(jobs.owner_id, func.count())
        .where(jobs.state == "queued", jobs.dispatched_at.is_(None))
        .group_by(jobs.owner_id)
    )
    for owner_id, count in rows.all():
        busy = (
            await conn.execute(select(jobs.id).where(*_jobs_open(owner_id), jobs.dispatched_at.is_not(None)))
        ).first()
        waiting_window = busy is None and not await within_gpu_minutes(conn, owner_id)
        held["gpu_minutes" if waiting_window else "account_turn"] += count
    return held


async def dispatch_waiting(engine: AsyncEngine, redis: ArqRedis) -> list[UUID]:
    """Safety net: try the dispatch of every account with a held job; return what it dispatched."""
    jobs = t.transcription_jobs.c
    async with system_tx(engine) as conn:
        owners = (
            await conn.execute(
                select(jobs.owner_id).where(jobs.state == "queued", jobs.dispatched_at.is_(None)).distinct()
            )
        ).scalars()
        owners = list(owners)
    dispatched = []
    for owner_id in owners:
        recording_id = await next_for(engine, redis, owner_id)
        if recording_id is not None:
            dispatched.append(recording_id)
    if dispatched:
        log.info("dispatch_waiting: %d recording(s) dispatched", len(dispatched))
    return dispatched
