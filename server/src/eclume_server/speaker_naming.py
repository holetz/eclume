"""Mandatory speaker naming: the pipeline's `speakers` step (holetz/eclume#144).

With `users.require_speaker_naming` on, ingestion stops the agent chain when some speaker with
enough speech was left without a person: the `speakers` step becomes `waiting` (`unnamed_speakers`)
and the agenda type is not queued. It leaves the wait when the owner links the last missing person
(`done`), when they release the recording (`continued_by_user`) or when they switch the preference
off (`naming_not_required`); the caller queues `detect_agenda_type` after the commit. Rules in
docs/standards/code/processamento-automatico.md `§Marcação dos locutores`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select, update

from eclume_server.db import tables as t
from eclume_server.pipeline import current_revision, get_step, set_step

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection
    from sqlalchemy.sql import ColumnElement, Select

    from eclume_server.serialize import Row

STEP = "speakers"
WAITING = "waiting"
# Diarization fragments do not hold the recording: the same floor as the voice comparison.
MIN_REQUIRED_TALK_MS = 10_000
UNNAMED = "unnamed_speakers"
CONTINUED = "continued_by_user"
NOT_REQUIRED = "naming_not_required"


async def required(conn: AsyncConnection, owner_id: UUID) -> bool:
    """Whether the account requires speaker naming."""
    query = select(t.users.c.require_speaker_naming).where(t.users.c.id == owner_id)
    return bool((await conn.execute(query)).scalar())


async def unnamed_count(conn: AsyncConnection, transcript_id: UUID) -> int:
    """How many of the transcript's speakers, with at least `MIN_REQUIRED_TALK_MS` of speech, have no person."""
    s = t.speakers.c
    query = (
        select(func.count())
        .select_from(t.speakers)
        .where(
            s.transcript_id == transcript_id,
            s.person_id.is_(None),
            func.coalesce(s.talk_ms, 0) >= MIN_REQUIRED_TALK_MS,
        )
    )
    return int((await conn.execute(query)).scalar_one())


async def gate(conn: AsyncConnection, recording: Row, revision: int, transcript_id: UUID) -> bool:
    """Write the `speakers` step of the just-ingested revision; `True` when the chain stops there.

    Runs in the ingestion transaction, after the links are restored and the voice attribution.
    """
    unnamed = await unnamed_count(conn, transcript_id) if await required(conn, recording["owner_id"]) else 0
    if unnamed:
        await set_step(conn, recording, revision, STEP, WAITING, detail={"reason": UNNAMED, "unnamed": unnamed})
        return True
    await set_step(conn, recording, revision, STEP, "done")
    return False


async def _waiting_revision(conn: AsyncConnection, recording_id: UUID) -> tuple[Row, int] | None:
    """`(recording, revision)` when the recording's current revision is paused at the speakers."""
    recording = (
        (
            await conn.execute(
                select(t.recordings.c.id, t.recordings.c.owner_id).where(t.recordings.c.id == recording_id)
            )
        )
        .mappings()
        .first()
    )
    if recording is None:
        return None
    revision = await current_revision(conn, recording_id)
    if revision is None:
        return None
    step = await get_step(conn, recording_id, revision, STEP)
    if step is None or step["state"] != WAITING:
        return None
    return dict(recording), revision


async def release_if_named(conn: AsyncConnection, recording_id: UUID) -> int | None:
    """Release the paused recording when no required speaker is left without a person; return the revision."""
    waiting = await _waiting_revision(conn, recording_id)
    if waiting is None:
        return None
    recording, revision = waiting
    transcript_id = (
        await conn.execute(select(t.transcripts.c.id).where(t.transcripts.c.recording_id == recording_id))
    ).scalar()
    unnamed = await unnamed_count(conn, transcript_id) if transcript_id is not None else 0
    if unnamed:
        # Someone is still missing: only the reason's count follows. The wait's instant stays, so the
        # outcome notices (which compare `finished_at`) do not repeat for each linked person.
        ps = t.pipeline_steps.c
        await conn.execute(
            update(t.pipeline_steps)
            .where(ps.recording_id == recording_id, ps.revision == revision, ps.step == STEP)
            .values(detail={"reason": UNNAMED, "unnamed": unnamed})
        )
        return None
    await set_step(conn, recording, revision, STEP, "done")
    return revision


async def release(conn: AsyncConnection, recording_id: UUID, reason: str) -> int | None:
    """Release the paused recording without requiring the names (`skipped` with `reason`); return the revision."""
    waiting = await _waiting_revision(conn, recording_id)
    if waiting is None:
        return None
    recording, revision = waiting
    await set_step(conn, recording, revision, STEP, "skipped", detail={"reason": reason})
    return revision


def waiting_select() -> Select[Any]:
    """`(recording_id, revision)` of the recordings whose current revision is paused at the speakers."""
    ps = t.pipeline_steps.c
    jobs = t.transcription_jobs.c
    latest = select(func.max(jobs.revision)).where(jobs.recording_id == ps.recording_id).scalar_subquery()
    return select(ps.recording_id, ps.revision).where(ps.step == STEP, ps.state == WAITING, ps.revision == latest)


def awaiting_condition() -> ColumnElement[bool]:
    """The library condition for `?awaiting=speakers`."""
    return t.recordings.c.id.in_(waiting_select().with_only_columns(t.pipeline_steps.c.recording_id))


async def waiting_count(conn: AsyncConnection) -> int:
    """How many recordings visible in the transaction are paused at the speakers."""
    return int((await conn.execute(select(func.count()).select_from(waiting_select().subquery()))).scalar_one())


async def release_account(conn: AsyncConnection, owner_id: UUID) -> list[tuple[UUID, int]]:
    """Release all of the account's paused recordings (the preference was switched off)."""
    ps = t.pipeline_steps.c
    rows = (await conn.execute(waiting_select().where(ps.owner_id == owner_id))).all()
    released = []
    for recording_id, revision in rows:
        recording = {"id": recording_id, "owner_id": owner_id}
        await set_step(conn, recording, revision, STEP, "skipped", detail={"reason": NOT_REQUIRED})
        released.append((recording_id, revision))
    return released


def awaiting_of(pipeline: list[dict[str, Any]]) -> str | None:
    """`Recording.awaiting`: `"speakers"` when the speakers step is waiting for the owner."""
    return "speakers" if any(step["step"] == STEP and step["state"] == WAITING for step in pipeline) else None
