"""Retentativa de jobs de transcrição pelo admin (`/admin/jobs/{job_id}/retry`). Só a sessão de admin.

Regras em docs/standards/code/server-admin.md: vale para a gravação de qualquer usuário, mas só para
o job mais recente da gravação e em estado `failed`, lido depois de travar a linha da gravação. A
resposta não traz conteúdo da gravação.
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
from eclume_server.pagination import iso
from eclume_server.problems import conflict, not_found
from eclume_server.recordings import enqueue_transcription, lock_recording, start_next_revision

router = APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])
Ctx = Annotated[AppContext, Depends(get_ctx)]


@router.post("/jobs/{job_id}/retry", status_code=202)
async def retry_job(job_id: UUID, ctx: Ctx) -> dict[str, Any]:
    """Cria e enfileira o job da revisão seguinte da gravação do job que falhou."""
    jobs = t.transcription_jobs
    # Papel de conexão: a gravação é de um usuário, não do admin.
    async with system_tx(ctx.engine) as conn:
        recording_id = (await conn.execute(select(jobs.c.recording_id).where(jobs.c.id == job_id))).scalar()
        if recording_id is None:
            raise not_found("Job inexistente.")
        # Trava a gravação antes de ler o estado: um segundo pedido simultâneo recebe 409.
        row = await lock_recording(conn, recording_id)
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
