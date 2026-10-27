"""Processing steps of a recording (`pipeline_steps`), per transcription job revision.

received → preprocessing → transcription → speakers → agenda type → fields → summary (the order of
`STEPS`). Each step is `pending`, `active`, `done`, `failed` or `skipped`, with the reason when
skipped or failed; the speakers step can also be `waiting`, for the owner (`speaker_naming.py`).
Contract and decisions in docs/standards/code/processamento-automatico.md.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from eclume_server.db import tables as t
from eclume_server.pagination import iso

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

PREPROCESS_FAILED = "preprocess_failed"
# GPU worker progress stage where the failure happened → the pipeline step it brings down.
FAILED_STEP = {"download": "preprocessing", "preprocess": "preprocessing"}
STEPS = ("received", "preprocessing", "transcription", "speakers", "agenda_type", "fields", "summary")
FINISHED = ("done", "failed", "skipped")
# The `speakers` step paused waiting for the owner (holetz/eclume#144): it has not finished, but it
# marks start and end like a final state; when it leaves the wait, the end is rewritten and the start kept.
STOPPED = (*FINISHED, "waiting")
# Outcomes of the `summary` step without a new summary that `?since=` must see.
UNSUMMARIZED = ("failed", "skipped")
# Outcomes of the step jobs that stop the chain: the revision is no longer the recording's.
GONE = "gravação apagada"
STALE = "revisão antiga"
# GPU worker stage (progress hash, already in the `Job.stage` vocabulary) → step in progress.
_ACTIVE_BY_STAGE = {"preprocessing": "preprocessing"}


async def set_step(  # noqa: PLR0913 — the step, the state and what it carries
    conn: AsyncConnection,
    recording: Row,
    revision: int,
    step: str,
    state: str,
    *,
    error: tuple[str, str] | None = None,
    detail: dict[str, Any] | None = None,
    started_at: datetime | None = None,
    finished_at: datetime | None = None,
) -> None:
    """Write the step's state; `active` marks the start, and a final state, the end.

    `recording` carries `id` and `owner_id`. It serves the routes (under the owner's RLS) and the
    workers (connection role).
    """
    ps = t.pipeline_steps
    now = func.now()
    values: dict[str, Any] = {
        "state": state,
        "error_code": error[0] if error else None,
        "error_message": error[1] if error else None,
        "detail": detail or {},
    }
    if state == "active":
        values |= {"started_at": started_at or now, "finished_at": None}
    elif state in STOPPED:
        values |= {"started_at": started_at or now, "finished_at": finished_at or now}
    update_values = dict(values)
    if state in STOPPED and started_at is None:
        # Finishing a step that had already started keeps its start.
        update_values["started_at"] = func.coalesce(ps.c.started_at, now)
    await conn.execute(
        pg_insert(ps)
        .values(owner_id=recording["owner_id"], recording_id=recording["id"], revision=revision, step=step, **values)
        .on_conflict_do_update(index_elements=[ps.c.recording_id, ps.c.revision, ps.c.step], set_=update_values)
    )
    if step == "summary" and state in UNSUMMARIZED:
        await mark_recording_changed(conn, recording["id"])


async def mark_recording_changed(conn: AsyncConnection, recording_id: UUID) -> None:
    """Move the recording's `updated_at`: the clients' `?since=` sees a summary that fails or is skipped.

    Only the recording: the transcript's `updated_at` moves only with a new summary, so lumea is not woken up.
    """
    await conn.execute(update(t.recordings).where(t.recordings.c.id == recording_id).values(updated_at=func.now()))


def _step_json(step: str, row: Row | None) -> dict[str, Any]:
    if row is None:
        return {
            "step": step,
            "state": "pending",
            "started_at": None,
            "finished_at": None,
            "duration_ms": None,
            "error": None,
            "reason": None,
        }
    error = {"code": row["error_code"], "message": row["error_message"] or ""} if row["error_code"] else None
    return {
        "step": step,
        "state": row["state"],
        "started_at": iso(row["started_at"]),
        "finished_at": iso(row["finished_at"]),
        "duration_ms": row["duration_ms"],
        "error": error,
        "reason": (row["detail"] or {}).get("reason"),
    }


async def load_pipelines(conn: AsyncConnection, recording_ids: list[UUID]) -> dict[UUID, list[Row]]:
    """The rows of each recording's highest revision."""
    if not recording_ids:
        return {}
    ps = t.pipeline_steps.c
    latest = (
        select(ps.recording_id, func.max(ps.revision).label("revision"))
        .where(ps.recording_id.in_(recording_ids))
        .group_by(ps.recording_id)
        .subquery()
    )
    rows = (
        (
            await conn.execute(
                select(t.pipeline_steps).join(
                    latest, (latest.c.recording_id == ps.recording_id) & (latest.c.revision == ps.revision)
                )
            )
        )
        .mappings()
        .all()
    )
    by_recording: dict[UUID, list[Row]] = {}
    for row in rows:
        by_recording.setdefault(row["recording_id"], []).append(row)
    return by_recording


def pipeline_json(rows: list[Row], running_stage: str | None) -> list[dict[str, Any]]:
    """Schema `PipelineStep[]`: the seven steps in order; without a row, `pending`.

    `running_stage` is the `Job.stage` stage while the GPU worker reports progress: it leaves
    preprocessing or transcription `active`.
    """
    by_step = {row["step"]: row for row in rows}
    steps = [_step_json(step, by_step.get(step)) for step in STEPS]
    if running_stage is not None:
        active = _ACTIVE_BY_STAGE.get(running_stage, "transcription")
        for item in steps:
            if item["step"] == active and item["state"] == "pending":
                item["state"] = "active"
    return steps


def gpu_started(engine_info: dict[str, Any], fallback: datetime) -> datetime:
    """The job's real start on the GPU worker (`engine_info.started_at` or the progress hash's)."""
    try:
        return datetime.fromisoformat(engine_info["started_at"])
    except (KeyError, TypeError, ValueError):
        return fallback


async def record_gpu_steps(conn: AsyncConnection, job: Row, engine_info: dict[str, Any], now: datetime) -> None:
    """Preprocessing and transcription done, from the GPU worker's `engine_info`.

    Preprocessing starts with the job on the worker and lasts `preprocess.ms`; transcription comes
    right after. A chain that fell back to format only ends `failed` (`preprocess_failed`), and
    transcription went on. A worker without preprocessing leaves the step skipped.
    """
    recording, revision = {"id": job["recording_id"], "owner_id": job["owner_id"]}, job["revision"]
    started = gpu_started(engine_info, job["started_at"] or job["queued_at"])
    pre = engine_info.get("preprocess")
    if not isinstance(pre, dict):
        await set_step(
            conn,
            recording,
            revision,
            "preprocessing",
            "skipped",
            detail={"reason": "worker_without_preprocess"},
            started_at=started,
            finished_at=started,
        )
        transcription_start = started
    else:
        # The end of preprocessing never goes past the end of the job (worker and server clocks).
        transcription_start = min(started + timedelta(milliseconds=int(pre.get("ms") or 0)), now)
        failed = [step for step in pre.get("steps", []) if step.get("state") == "failed"]
        error = (PREPROCESS_FAILED, str(failed[0].get("error") or "")[:500]) if failed else None
        await set_step(
            conn,
            recording,
            revision,
            "preprocessing",
            "failed" if error else "done",
            error=error,
            detail={key: pre.get(key) for key in ("steps", "offset_ms", "channels", "split", "fallback", "warnings")},
            started_at=started,
            finished_at=transcription_start,
        )
    await set_step(
        conn,
        recording,
        revision,
        "transcription",
        "done",
        detail={"warnings": engine_info.get("warnings") or []},
        started_at=transcription_start,
        finished_at=now,
    )


async def get_step(conn: AsyncConnection, recording_id: UUID, revision: int, step: str) -> Row | None:
    """The step's row, if it already exists."""
    ps = t.pipeline_steps.c
    query = select(t.pipeline_steps).where(ps.recording_id == recording_id, ps.revision == revision, ps.step == step)
    return (await conn.execute(query)).mappings().first()


async def current_revision(conn: AsyncConnection, recording_id: UUID) -> int | None:
    """The revision of the recording's most recent transcription job (that of the running chain)."""
    jobs = t.transcription_jobs.c
    return (await conn.execute(select(func.max(jobs.revision)).where(jobs.recording_id == recording_id))).scalar()
