"""Bucket deletion queue (`storage_deletions`): the drain with retries and the reconciliation.

The migration 024 triggers enqueue, in the same transaction as the `DELETE`, the audio and the
`recordings/{id}/` prefix of the deleted recording and the multipart of the upload in progress. The
`drain_storage_deletions` cron (every minute) removes them from the bucket; a failure increments
`attempts`, stores `last_error` and postpones (1 min, doubling up to 1 h), never giving up. The
`reconcile_storage` cron (weekly) enqueues what is left in the bucket with no database row for more
than 24 h. Rules in docs/standards/code/server-nucleo.md `§Exclusão no armazenamento`.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import delete, insert, select, update

from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.storage import ARTIFACTS_ROOT

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

    from eclume_server.serialize import Row
    from eclume_server.storage import Storage

log = logging.getLogger(__name__)

DRAIN_BATCH = 100
FIRST_DELAY = timedelta(minutes=1)
MAX_DELAY = timedelta(hours=1)
# Reconciliation margin: covers the object assembled by a `complete` whose commit has not happened yet.
ORPHAN_AGE = timedelta(hours=24)
# Bucket roots the reconciliation walks: audio (the old organization keys too) and GPU worker
# artifacts.
AUDIO_ROOTS = ("users/", "orgs/")
_ERROR_LIMIT = 500


def retry_delay(attempts: int) -> timedelta:
    """The wait after the `attempts`-th failure: 1 min, doubling, up to 1 h."""
    return min(FIRST_DELAY * 2 ** max(attempts - 1, 0), MAX_DELAY)


async def _remove(storage: Storage, row: Row) -> None:
    if row["prefix"] is not None:
        await storage.delete_keys(await storage.list_keys(row["prefix"]))
    elif row["s3_upload_id"] is not None:
        await storage.abort_multipart(row["key"], row["s3_upload_id"])
    else:
        await storage.delete_keys([row["key"]])


async def drain(engine: AsyncEngine, storage: Storage, now: datetime | None = None, limit: int = DRAIN_BATCH) -> int:
    """Remove up to `limit` due rows from the bucket; return how many left the queue."""
    now = now or datetime.now(UTC)
    sd = t.storage_deletions
    done = 0
    async with system_tx(engine) as conn:
        rows = (
            (
                await conn.execute(
                    select(sd)
                    .where(sd.c.next_attempt_at <= now)
                    .order_by(sd.c.next_attempt_at)
                    .limit(limit)
                    .with_for_update(skip_locked=True)
                )
            )
            .mappings()
            .all()
        )
        for row in rows:
            try:
                await _remove(storage, row)
            except Exception as exc:  # noqa: BLE001 — any S3 failure postpones the row, which never gives up
                attempts = row["attempts"] + 1
                await conn.execute(
                    update(sd)
                    .where(sd.c.id == row["id"])
                    .values(
                        attempts=attempts,
                        last_error=f"{type(exc).__name__}: {exc}"[:_ERROR_LIMIT],
                        next_attempt_at=now + retry_delay(attempts),
                    )
                )
                log.warning("storage deletion %s failed (attempt %d): %s", row["id"], attempts, exc)
                continue
            await conn.execute(delete(sd).where(sd.c.id == row["id"]))
            done += 1
    return done


async def _queued(conn: AsyncConnection) -> tuple[set[str], set[str], set[str]]:
    """Keys, prefixes and multiparts already queued."""
    sd = t.storage_deletions.c
    rows = (await conn.execute(select(sd.key, sd.prefix, sd.s3_upload_id))).all()
    keys = {key for key, _, upload in rows if key is not None and upload is None}
    prefixes = {prefix for _, prefix, _ in rows if prefix is not None}
    uploads = {upload for _, _, upload in rows if upload is not None}
    return keys, prefixes, uploads


async def reconcile(engine: AsyncEngine, storage: Storage, now: datetime | None = None) -> int:
    """Enqueue what has been in the bucket for more than `ORPHAN_AGE` with no database row; return how many."""
    cutoff = (now or datetime.now(UTC)) - ORPHAN_AGE
    async with system_tx(engine) as conn:
        r = t.recordings.c
        audio_keys = set((await conn.execute(select(r.audio_key).where(r.audio_key.is_not(None)))).scalars())
        recording_ids = {str(value) for value in (await conn.execute(select(r.id))).scalars()}
        u = t.uploads.c
        open_uploads = set((await conn.execute(select(u.s3_upload_id).where(u.status == "in_progress"))).scalars())
        queued_keys, queued_prefixes, queued_uploads = await _queued(conn)

    known_keys, known_uploads = audio_keys | queued_keys, open_uploads | queued_uploads
    rows: list[dict[str, str]] = []
    for root in AUDIO_ROOTS:
        rows.extend(
            {"key": obj.key}
            for obj in await storage.list_objects(root)
            if obj.last_modified <= cutoff and obj.key not in known_keys
        )
    orphan_prefixes = set()
    for obj in await storage.list_objects(ARTIFACTS_ROOT):
        recording_id = obj.key.removeprefix(ARTIFACTS_ROOT).split("/", 1)[0]
        prefix = f"{ARTIFACTS_ROOT}{recording_id}/"
        if obj.last_modified <= cutoff and recording_id not in recording_ids and prefix not in queued_prefixes:
            orphan_prefixes.add(prefix)
    rows.extend({"prefix": prefix} for prefix in sorted(orphan_prefixes))
    rows.extend(
        {"key": pending.key, "s3_upload_id": pending.upload_id}
        for pending in await storage.list_multipart_uploads()
        if pending.initiated <= cutoff and pending.upload_id not in known_uploads
    )

    if rows:
        async with system_tx(engine) as conn:
            for row in rows:
                await conn.execute(insert(t.storage_deletions).values(**row))
        log.warning("storage reconciliation: %d orphans in the deletion queue", len(rows))
    return len(rows)
