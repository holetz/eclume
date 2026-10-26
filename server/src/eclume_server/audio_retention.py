"""Audio retention: the account's choice, the admin ceiling and the purge that keeps the transcript.

`users.audio_retention_days` is the account's value (null = off, the default). The platform ceiling
is `platform_settings.retention.audio_max_days` (null = none) and only caps a user value; it never
deletes audio of an account that left retention off. The daily `purge_audio` cron removes the audio
of every recording older than the effective window: `audio_key` becomes null, `audio_deleted_at` is
set, and the object goes to the `storage_deletions` queue, which retries until the bucket lets go.
Transcript, summary and the per-recording artefacts stay. Rules in
docs/standards/code/server-nucleo.md §Audio retention.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import insert, select, text, update

from eclume_server.db import tables as t
from eclume_server.db.session import system_tx

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

log = logging.getLogger(__name__)

MIN_DAYS = 1
MAX_DAYS = 3650
PURGE_BATCH = 200

# A recording is due when it is older than the account's effective window and no transcription job
# is queued or running (the job reads the audio). The same predicate re-runs under the row lock.
_DUE = """
    r.audio_key IS NOT NULL
    AND u.audio_retention_days IS NOT NULL
    AND r.created_at < CAST(:now AS timestamptz) - make_interval(
        days => LEAST(u.audio_retention_days, COALESCE((p.retention ->> 'audio_max_days')::int, u.audio_retention_days))
    )
    AND NOT EXISTS (
        SELECT 1 FROM transcription_jobs j WHERE j.recording_id = r.id AND j.state IN ('queued', 'running')
    )
"""
_FROM = "FROM recordings r JOIN users u ON u.id = r.owner_id CROSS JOIN platform_settings p"
_CANDIDATES = text(f"SELECT r.id {_FROM} WHERE {_DUE} ORDER BY r.created_at LIMIT :limit")
_LOCK = text(f"SELECT r.audio_key {_FROM} WHERE r.id = :id AND {_DUE} FOR UPDATE OF r")


def effective_days(user_days: int | None, max_days: int | None) -> int | None:
    """The window in force: off without a user value, otherwise the user value capped by the ceiling."""
    if user_days is None:
        return None
    return user_days if max_days is None else min(user_days, max_days)


def platform_max_days(retention: dict[str, Any] | None) -> int | None:
    """The ceiling stored in `platform_settings.retention`, or `None` when there is none."""
    return (retention or {}).get("audio_max_days")


async def retention_json(conn: AsyncConnection, user_id: UUID) -> dict[str, Any]:
    """Schema `AudioRetention`: the account's value, the ceiling and the window actually in force."""
    days = (await conn.execute(select(t.users.c.audio_retention_days).where(t.users.c.id == user_id))).scalar()
    max_days = platform_max_days((await conn.execute(select(t.platform_settings.c.retention))).scalar_one())
    return {"days": days, "max_days": max_days, "effective_days": effective_days(days, max_days)}


async def set_account_days(conn: AsyncConnection, user_id: UUID, days: int | None) -> None:
    """Store the account's value; `None` turns retention off. A value above the ceiling is kept and capped on read."""
    await conn.execute(update(t.users).where(t.users.c.id == user_id).values(audio_retention_days=days))


async def _purge_one(engine: AsyncEngine, recording_id: UUID, now: datetime) -> bool:
    async with system_tx(engine) as conn:
        key = (await conn.execute(_LOCK, {"id": recording_id, "now": now})).scalar()
        if key is None:
            return False
        await conn.execute(
            update(t.recordings).where(t.recordings.c.id == recording_id).values(audio_key=None, audio_deleted_at=now)
        )
        await conn.execute(insert(t.storage_deletions).values(key=key))
    return True


async def purge_due_audio(engine: AsyncEngine, now: datetime | None = None, limit: int = PURGE_BATCH) -> int:
    """Delete the audio of up to `limit` recordings past their account's window; returns how many.

    One short transaction per recording, so a failure leaves the rest for the next run. A recording
    with a queued or running job is skipped and picked up later.
    """
    now = now or datetime.now(UTC)
    async with system_tx(engine) as conn:
        due = list((await conn.execute(_CANDIDATES, {"now": now, "limit": limit})).scalars())
    purged = 0
    for recording_id in due:
        if await _purge_one(engine, recording_id, now):
            purged += 1
    log.info("purge_audio: %d of %d due recordings", purged, len(due))
    return purged
