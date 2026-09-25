"""Retentativa de jobs de transcrição pelo admin (`/admin/jobs/{job_id}/retry`). Só sessão de `admin`.

Regras em docs/standards/code/server-admin.md: vale para qualquer gravação da organização,
inclusive privada, mas só para o job mais recente da gravação e em estado `failed`.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy import select

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.pagination import iso
from eclume_server.problems import conflict, not_found
from eclume_server.recordings import enqueue_transcription, recording_select, start_next_revision

router = APIRouter(prefix="/admin")
Ctx = Annotated[AppContext, Depends(get_ctx)]
Admin = Annotated[Principal, Depends(requires(session_only=True, admin=True))]


@router.post("/jobs/{job_id}/retry", status_code=202)
async def retry_job(job_id: UUID, principal: Admin, ctx: Ctx) -> dict[str, Any]:
    """Cria e enfileira o job da revisão seguinte da gravação do job que falhou."""
    jobs = t.transcription_jobs
    # Papel de sistema: o admin retenta também a gravação privada de outro membro da organização.
    async with system_tx(ctx.engine) as conn:
        recording_id = (
            await conn.execute(
                select(jobs.c.recording_id).where(jobs.c.id == job_id, jobs.c.org_id == principal.org_id)
            )
        ).scalar()
        if recording_id is None:
            raise not_found("Job inexistente.")
        row = (
            (
                await conn.execute(
                    recording_select().where(t.recordings.c.id == recording_id).with_for_update(of=t.recordings)
                )
            )
            .mappings()
            .one()
        )
        if row["job_id"] != job_id:
            raise conflict("A gravação já tem um job mais recente que este.")
        if row["job_state"] != "failed":
            raise conflict("Só um job que falhou pode ser retentado.")
        revision, options = await start_next_revision(conn, row, row["language"])
        new_job = (
            await conn.execute(
                select(jobs.c.id, jobs.c.queued_at).where(
                    jobs.c.recording_id == recording_id, jobs.c.revision == revision
                )
            )
        ).one()
    await enqueue_transcription(ctx, recording_id, revision, row["audio_key"], options)
    return {
        "job_id": str(new_job.id),
        "recording_id": str(recording_id),
        "revision": revision,
        "state": "queued",
        "queued_at": iso(new_job.queued_at),
    }
