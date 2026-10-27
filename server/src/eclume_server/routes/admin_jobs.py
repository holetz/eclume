"""Retrying transcription jobs by the admin (`/admin/jobs/{job_id}/retry`). Admin session only.

Rules in docs/standards/code/server-admin.md: it applies to any user's recording, but only to the
recording's most recent job and in the `failed` state, read after locking the recording's row. The
response carries no recording content.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy import select

from eclume_server.auth import require_admin
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.dispatch import next_for
from eclume_server.pagination import iso
from eclume_server.problems import conflict, not_found
from eclume_server.recordings import lock_recording, start_next_revision

router = APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])
Ctx = Annotated[AppContext, Depends(get_ctx)]


@router.post("/jobs/{job_id}/retry", status_code=202)
async def retry_job(job_id: UUID, ctx: Ctx) -> dict[str, Any]:
    """Create and enqueue the job of the next revision of the failed job's recording."""
    jobs = t.transcription_jobs
    # Connection role: the recording belongs to a user, not to the admin.
    async with system_tx(ctx.engine) as conn:
        recording_id = (await conn.execute(select(jobs.c.recording_id).where(jobs.c.id == job_id))).scalar()
        if recording_id is None:
            raise not_found("Job inexistente.")
        # Lock the recording before reading the state: a second concurrent request gets 409.
        row = await lock_recording(conn, recording_id)
        if row["job_id"] != job_id:
            raise conflict("A gravação já tem um job mais recente que este.")
        if row["job_state"] != "failed":
            raise conflict("Só um job que falhou pode ser retentado.")
        revision = await start_next_revision(conn, row, row["language"])
        new_job = (
            await conn.execute(
                select(jobs.c.id, jobs.c.queued_at).where(
                    jobs.c.recording_id == recording_id, jobs.c.revision == revision
                )
            )
        ).one()
    await next_for(ctx.engine, ctx.queue.pool, row["owner_id"])
    return {
        "job_id": str(new_job.id),
        "recording_id": str(recording_id),
        "revision": revision,
        "state": "queued",
        "queued_at": iso(new_job.queued_at),
    }
