"""Why a `queued` `transcribe` waits: the recordings' `Job.queue`.

Three reasons: in the processor's queue (`processor_queue`, already in `eclume:gpu`), behind other
recordings of the same account (`account_turn`, held by the fair queue) or in the 24 h minutes
window (`quota_window`). Only counts and times: nothing about another account leaves here.
Computed on read, once per response. Rules in docs/standards/api/jobs-transcricao.md.
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from arq.constants import in_progress_key_prefix
from sqlalchemy import func, select

from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.pagination import iso
from eclume_server.queue import GPU_HEALTH_KEY, GPU_LAST_SEEN_KEY, GPU_QUEUE, progress_key, transcribe_job_id
from eclume_server.quotas import WINDOW_S, effective

if TYPE_CHECKING:
    from uuid import UUID

    from arq.connections import ArqRedis
    from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

    from eclume_server.queue import Queue
    from eclume_server.serialize import Row

# Processor pace: the median of the latest successful transcriptions, kept in Redis.
PACE_KEY = "eclume:queue:pace"
PACE_TTL_S = 300
PACE_SAMPLES = 20
PACE_MIN_SAMPLES = 5
PACE_WINDOW = timedelta(days=7)
_OPEN = ("queued", "running")


async def pace(engine: AsyncEngine, redis: ArqRedis) -> tuple[float, float] | None:
    """`(processing per ms of audio, median processing in ms)`, or `None` without history."""
    cached = await redis.get(PACE_KEY)
    if cached is not None:
        data = json.loads(cached)
        return None if data is None else (data[0], data[1])
    jobs, recordings = t.transcription_jobs.c, t.recordings.c
    elapsed_ms = func.extract("epoch", jobs.finished_at - jobs.started_at) * 1000
    sample = (
        select(elapsed_ms.label("ms"), func.nullif(recordings.duration_ms, 0).label("audio_ms"))
        .select_from(t.transcription_jobs.join(t.recordings, recordings.id == jobs.recording_id))
        .where(
            jobs.state == "succeeded",
            jobs.started_at.is_not(None),
            jobs.finished_at > jobs.started_at,
            jobs.finished_at >= datetime.now(UTC) - PACE_WINDOW,
        )
        .order_by(jobs.finished_at.desc())
        .limit(PACE_SAMPLES)
        .subquery()
    )
    # Only numbers, for the whole platform: the connection role.
    async with system_tx(engine) as conn:
        count, ratio, median_ms = (
            await conn.execute(
                select(
                    func.count(),
                    func.percentile_cont(0.5).within_group(sample.c.ms / sample.c.audio_ms),
                    func.percentile_cont(0.5).within_group(sample.c.ms),
                )
            )
        ).one()
    found = None if count < PACE_MIN_SAMPLES or ratio is None else (float(ratio), float(median_ms))
    await redis.set(PACE_KEY, json.dumps(found), ex=PACE_TTL_S)
    return found


def _wait(reason: str, **fields: Any) -> dict[str, Any]:  # noqa: ANN401
    """`Job.queue` without the processor: the reason (not the `reason` of a skipped step) and its fields."""
    empty = {"ahead": None, "account_ahead": None, "estimated_start_at": None, "resumes_at": None}
    return {"reason": reason} | empty | fields


def _recording_of(job_id: str) -> str | None:
    """The recording of the `_job_id` `transcribe:{recording_id}:{revision}`."""
    parts = job_id.split(":")
    return parts[1] if len(parts) == 3 and parts[0] == "transcribe" else None  # noqa: PLR2004


def _parse(moment: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(moment) if moment else None
    except ValueError:
        return None


class _Processor:
    """What the `eclume:gpu` queue and the heartbeat say, read once per response."""

    def __init__(self, job_ids: list[str], *, online: bool, offline_since: str | None) -> None:
        self.job_ids = job_ids
        self.online = online
        self.offline_since = offline_since
        self.estimates: list[float] | None = None

    def json(self) -> dict[str, Any]:
        return {"online": self.online, "offline_since": None if self.online else self.offline_since}

    async def load_estimates(self, engine: AsyncEngine, queue: Queue, now: datetime) -> None:
        """How much is left, in ms, for each job in the queue; without a known pace, nothing."""
        found = await pace(engine, queue.pool)
        if found is None:
            return
        ratio, median_ms = found
        recordings = [rid for job_id in self.job_ids if (rid := _recording_of(job_id))]
        async with system_tx(engine) as conn:
            rows = await conn.execute(
                select(t.recordings.c.id, t.recordings.c.duration_ms).where(t.recordings.c.id.in_(recordings))
            )
            durations = {str(rid): ms for rid, ms in rows.all()}
        pipe = queue.pool.pipeline(transaction=False)
        for job_id in self.job_ids:
            pipe.exists(in_progress_key_prefix + job_id)
            pipe.hget(progress_key(_recording_of(job_id) or ""), "started_at")
        flags = await pipe.execute()
        estimates = []
        for index, job_id in enumerate(self.job_ids):
            rid = _recording_of(job_id)
            audio_ms = durations.get(rid)
            estimate = audio_ms * ratio if audio_ms else median_ms
            running, started = flags[2 * index], flags[2 * index + 1]
            started_at = _parse(started.decode() if isinstance(started, bytes) else started)
            if running and started_at is not None:
                estimate = max(0.0, estimate - (now - started_at).total_seconds() * 1000)
            estimates.append(estimate)
        self.estimates = estimates

    def wait(self, job_id: str, now: datetime) -> dict[str, Any]:
        """Position and estimated start of an already dispatched job."""
        ahead = self.job_ids.index(job_id) if job_id in self.job_ids else None
        estimated = None
        if ahead is not None and self.online and self.estimates is not None:
            estimated = iso(now + timedelta(milliseconds=sum(self.estimates[:ahead])))
        return _wait("processor_queue", ahead=ahead, estimated_start_at=estimated)


async def _resumes_at(conn: AsyncConnection, owner_id: UUID, limit: int) -> str | None:
    """When the account has minutes again: the dispatch that, leaving the 24 h window, puts it below the quota."""
    jobs, recordings = t.transcription_jobs.c, t.recordings.c
    since = datetime.now(UTC) - timedelta(seconds=WINDOW_S)
    rows = (
        await conn.execute(
            select(jobs.dispatched_at, func.coalesce(recordings.duration_ms, 0))
            .select_from(t.transcription_jobs.join(t.recordings, recordings.id == jobs.recording_id))
            .where(jobs.owner_id == owner_id, jobs.dispatched_at >= since)
            .order_by(jobs.dispatched_at)
        )
    ).all()
    used_ms = sum(int(ms) for _, ms in rows)
    if math.ceil(used_ms / 60_000) < limit:
        return None
    for dispatched_at, ms in rows:
        used_ms -= int(ms)
        if math.ceil(used_ms / 60_000) < limit:
            return iso(dispatched_at + timedelta(seconds=WINDOW_S))
    return None


async def _held(engine: AsyncEngine, owner_id: UUID) -> dict[str, dict[str, Any]]:
    """The wait of an account's held jobs, by job id."""
    jobs = t.transcription_jobs.c
    async with system_tx(engine) as conn:
        rows = (
            await conn.execute(
                select(jobs.id, jobs.dispatched_at)
                .where(jobs.owner_id == owner_id, jobs.state.in_(_OPEN))
                .order_by(jobs.dispatched_at.is_(None), jobs.queued_at, jobs.id)
            )
        ).all()
        busy = any(dispatched_at is not None for _, dispatched_at in rows)
        limit = None if busy else (await effective(conn, owner_id))["gpu_minutes_24h"]
        resumes_at = None if limit is None else await _resumes_at(conn, owner_id, limit)
    waits = {}
    for ahead, (job_id, dispatched_at) in enumerate(rows):
        if dispatched_at is not None:
            continue
        # With no dispatched job and no window to wait for, the next dispatch (or the cron) takes it: account turn.
        if resumes_at is not None:
            waits[str(job_id)] = _wait("quota_window", resumes_at=resumes_at)
        else:
            waits[str(job_id)] = _wait("account_turn", account_ahead=ahead)
    return waits


async def waiting(engine: AsyncEngine, queue: Queue, rows: list[Row]) -> dict[UUID, dict[str, Any]]:
    """The `Job.queue` of each recording whose job is `queued` (no progress), by recording id."""
    if not rows:
        return {}
    now = datetime.now(UTC)
    pipe = queue.pool.pipeline(transaction=False)
    pipe.zrange(GPU_QUEUE, 0, -1)
    pipe.exists(GPU_HEALTH_KEY)
    pipe.get(GPU_LAST_SEEN_KEY)
    job_ids, online, last_seen = await pipe.execute()
    processor = _Processor(
        [job_id.decode() for job_id in job_ids],
        online=bool(online),
        offline_since=last_seen.decode() if last_seen else None,
    )
    if processor.online and any(row["job_dispatched_at"] is not None for row in rows):
        await processor.load_estimates(engine, queue, now)
    held: dict[str, dict[str, Any]] = {}
    for owner_id in {row["owner_id"] for row in rows if row["job_dispatched_at"] is None}:
        held |= await _held(engine, owner_id)
    result = {}
    for row in rows:
        if row["job_dispatched_at"] is not None:
            base = processor.wait(transcribe_job_id(row["id"], row["job_revision"]), now)
        else:
            base = held.get(str(row["job_id"]), _wait("account_turn"))
        result[row["id"]] = base | {"processor": processor.json()}
    return result
