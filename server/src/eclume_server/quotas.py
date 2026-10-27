"""Per-account quotas: the effective quota (the account's override over the default), the usage and the checks.

The default quotas live in `platform_settings.quotas`; `users.quotas` keeps only the fields the
account overrides. `null` is "no limit". GPU minutes and agent requests count over a rolling 24 h
window: the minutes by the duration of the dispatched recordings (`transcription_jobs.dispatched_at`),
the requests in a per-account sorted set in Redis (`eclume:quota:agent:{owner}`), trimmed on every
read. Contract in docs/standards/code/server-nucleo.md (`§Upload e áudio`) and server-agentes.md.
"""

from __future__ import annotations

import logging
import math
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from sqlalchemy import func, select

from eclume_server.db import tables as t
from eclume_server.problems import ApiProblemError, rate_limited

if TYPE_CHECKING:
    from collections.abc import AsyncIterator
    from uuid import UUID

    from arq.connections import ArqRedis
    from sqlalchemy.ext.asyncio import AsyncConnection

FIELDS = ("storage_bytes", "file_bytes", "open_uploads", "gpu_minutes_24h", "agent_requests_24h")
WINDOW_S = 24 * 3600
# Queued or running summaries per account: each one occupies the agent.
MAX_OPEN_SUMMARIES = 3


def quota_exceeded(quota: str, limit: int, used: int) -> ApiProblemError:
    """403 — the account went over a quota; `quota`, `limit` and `used` say which and by how much."""
    return ApiProblemError(
        403,
        "quota_exceeded",
        f"A cota {quota} da conta é {limit} e o uso chegaria a {used}.",
        extra={"quota": quota, "limit": limit, "used": used},
    )


def merge(default: dict[str, Any], override: dict[str, Any] | None) -> dict[str, int | None]:
    """Effective quota: the account's override, field by field, over the platform default."""
    override = override or {}
    return {field: override[field] if field in override else default.get(field) for field in FIELDS}


async def effective(conn: AsyncConnection, owner_id: UUID) -> dict[str, int | None]:
    """The account's effective quota (reads `platform_settings` and `users`)."""
    default = (await conn.execute(select(t.platform_settings.c.quotas))).scalar_one()
    override = (await conn.execute(select(t.users.c.quotas).where(t.users.c.id == owner_id))).scalar()
    return merge(default, override)


def _open_upload(now: datetime) -> Any:  # noqa: ANN401
    u = t.uploads.c
    return (u.status == "in_progress") & (u.expires_at > now)


async def storage_used(conn: AsyncConnection, owner_id: UUID) -> tuple[int, int]:
    """`(stored bytes, open uploads)`: the recordings' audio plus the uploads in progress."""
    now = datetime.now(UTC)
    recorded = (
        await conn.execute(
            select(func.coalesce(func.sum(t.recordings.c.size_bytes), 0)).where(t.recordings.c.owner_id == owner_id)
        )
    ).scalar_one()
    uploading, count = (
        await conn.execute(
            select(func.coalesce(func.sum(t.uploads.c.size_bytes), 0), func.count()).where(
                t.uploads.c.owner_id == owner_id, _open_upload(now)
            )
        )
    ).one()
    return int(recorded) + int(uploading), int(count)


async def gpu_minutes_used(conn: AsyncConnection, owner_id: UUID) -> int:
    """Minutes of audio dispatched to the GPU in the last 24 h (rounded up)."""
    jobs, recordings = t.transcription_jobs.c, t.recordings.c
    since = datetime.now(UTC) - timedelta(seconds=WINDOW_S)
    total_ms = (
        await conn.execute(
            select(func.coalesce(func.sum(func.coalesce(recordings.duration_ms, 0)), 0))
            .select_from(t.transcription_jobs.join(t.recordings, recordings.id == jobs.recording_id))
            .where(jobs.owner_id == owner_id, jobs.dispatched_at >= since)
        )
    ).scalar_one()
    return math.ceil(int(total_ms) / 60_000)


def agent_key(owner_id: UUID | str) -> str:
    """Sorted set (by instant) of the account's agent requests."""
    return f"eclume:quota:agent:{owner_id}"


async def agent_requests_used(redis: ArqRedis, owner_id: UUID) -> int:
    """Agent requests in the last 24 h, trimming the oldest ones."""
    key = agent_key(owner_id)
    await redis.zremrangebyscore(key, "-inf", time.time() - WINDOW_S)
    return int(await redis.zcard(key))


async def usage(conn: AsyncConnection, redis: ArqRedis, owner_id: UUID) -> dict[str, Any]:
    """Schema `Usage`: the account's usage and the effective quota."""
    storage, open_uploads = await storage_used(conn, owner_id)
    return {
        "usage": {
            "storage_bytes": storage,
            "open_uploads": open_uploads,
            "gpu_minutes_24h": await gpu_minutes_used(conn, owner_id),
            "agent_requests_24h": await agent_requests_used(redis, owner_id),
        },
        "quotas": await effective(conn, owner_id),
    }


async def check_upload(conn: AsyncConnection, owner_id: UUID, size_bytes: int) -> None:
    """Refuse a new upload that exceeds the per-file size, the storage or the open uploads."""
    quotas = await effective(conn, owner_id)
    file_limit = quotas["file_bytes"]
    if file_limit is not None and size_bytes > file_limit:
        raise quota_exceeded("file_bytes", file_limit, size_bytes)
    storage, open_uploads = await storage_used(conn, owner_id)
    open_limit = quotas["open_uploads"]
    if open_limit is not None and open_uploads + 1 > open_limit:
        raise quota_exceeded("open_uploads", open_limit, open_uploads + 1)
    storage_limit = quotas["storage_bytes"]
    if storage_limit is not None and storage + size_bytes > storage_limit:
        raise quota_exceeded("storage_bytes", storage_limit, storage + size_bytes)


async def within_gpu_minutes(conn: AsyncConnection, owner_id: UUID) -> bool:
    """Whether the account still has GPU minutes in the 24 h window."""
    limit = (await effective(conn, owner_id))["gpu_minutes_24h"]
    return limit is None or await gpu_minutes_used(conn, owner_id) < limit


async def agent_limit(conn: AsyncConnection, owner_id: UUID) -> int | None:
    """Effective quota of agent requests in 24 h."""
    return (await effective(conn, owner_id))["agent_requests_24h"]


# Trims the window, compares and adds in a single Redis round trip: concurrent requests of the same
# account never read the same usage. Returns 0 when it counted and `usage + 1` when it refused. ARGV:
# now, window, limit (-1 for no limit), member.
_TAKE = """
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
local used = redis.call('ZCARD', KEYS[1])
local limit = tonumber(ARGV[3])
if limit >= 0 and used + 1 > limit then
  return used + 1
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 0
"""

_log = logging.getLogger(__name__)


async def take_agent_request(redis: ArqRedis, owner_id: UUID, limit: int | None) -> str:
    """Count one of the person's agent requests, atomically; return the token `refund_agent_request` refunds.

    Over the 24 h quota, 403 `quota_exceeded`.
    """
    member = str(uuid4())
    script = redis.register_script(_TAKE)
    refused = int(
        await script(
            keys=[agent_key(owner_id)],
            args=[time.time(), WINDOW_S, -1 if limit is None else limit, member],
        )
    )
    if refused:
        raise quota_exceeded("agent_requests_24h", limit, refused)
    return member


async def refund_agent_request(redis: ArqRedis, owner_id: UUID, token: str) -> None:
    """Give back the quota of a request that did not go out; idempotent and never raises (does not mask the original error)."""
    try:
        await redis.zrem(agent_key(owner_id), token)
    except Exception:  # noqa: BLE001 — the refund never masks the original error
        _log.exception("could not refund the agent quota of %s", owner_id)


class AgentCharge:
    """The token of the quota spent inside `refunding`; empty until the charge happens."""

    token: str | None = None


@asynccontextmanager
async def refunding(redis: ArqRedis, owner_id: UUID) -> AsyncIterator[AgentCharge]:
    """Refund the charged quota (`charge.token`) if the block fails afterwards; re-raise the error."""
    charge = AgentCharge()
    try:
        yield charge
    except BaseException:
        if charge.token is not None:
            await refund_agent_request(redis, owner_id, charge.token)
        raise


async def charge_agent(conn: AsyncConnection, redis: ArqRedis, owner_id: UUID) -> str:
    """`take_agent_request` with the account's effective quota; return the token."""
    return await take_agent_request(redis, owner_id, await agent_limit(conn, owner_id))


async def check_open_summaries(conn: AsyncConnection, owner_id: UUID) -> None:
    """With `MAX_OPEN_SUMMARIES` summaries queued or running, 429 `rate_limited`."""
    s = t.summaries.c
    count = (
        await conn.execute(select(func.count()).where(s.owner_id == owner_id, s.status.in_(("queued", "running"))))
    ).scalar_one()
    if count >= MAX_OPEN_SUMMARIES:
        raise rate_limited(f"Já há {MAX_OPEN_SUMMARIES} resumos em andamento; espere um terminar.")
