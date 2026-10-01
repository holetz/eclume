"""Despacho na vez da conta: a fila justa da GPU sem mexer no arq.

Cada conta tem no máximo um `transcribe` em `eclume:gpu`. O job nasce `queued` sem
`dispatched_at` (retido no banco); `next_for` o marca e o enfileira quando a conta não tem outro
despachado em aberto e ainda está dentro dos minutos de GPU de 24 h. Com um job por conta na fila
FIFO do arq, o rodízio entre contas sai sozinho. Quem chama: o `complete` do upload, retranscrever,
a retentativa do admin, a ingestão e a falha do `transcribe`, e o cron `dispatch_waiting` como rede.
Regras em docs/standards/api/jobs-transcricao.md §Filas.
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

# Primeira chave do `pg_advisory_xact_lock(int, int)` do despacho; a segunda é a conta.
_LOCK_CLASS = 98
_OPEN = ("queued", "running")


def _jobs_open(owner_id: UUID) -> list:
    jobs = t.transcription_jobs.c
    return [jobs.owner_id == owner_id, jobs.state.in_(_OPEN)]


async def _lock(conn: AsyncConnection, owner_id: UUID) -> None:
    await conn.execute(select(func.pg_advisory_xact_lock(_LOCK_CLASS, func.hashtext(str(owner_id)))))


async def next_for(engine: AsyncEngine, redis: ArqRedis, owner_id: UUID) -> UUID | None:
    """Despacha o job retido mais antigo da conta, se é a vez dela; devolve a gravação despachada.

    O enfileiramento vem depois do commit: se ele se perde, o job despachado fica sem arq e o reaper
    o põe de volta na fila uma vez (`stalled.py`).
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
        payload = await transcribe_payload(conn, waiting["options"] or {})
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
    """`next_for` da conta dona da gravação (a ingestão e a falha só conhecem a gravação)."""
    async with system_tx(engine) as conn:
        owner_id = (
            await conn.execute(select(t.recordings.c.owner_id).where(t.recordings.c.id == recording_id))
        ).scalar()
    return None if owner_id is None else await next_for(engine, redis, owner_id)


async def dispatch_waiting(engine: AsyncEngine, redis: ArqRedis) -> list[UUID]:
    """Rede de segurança: tenta o despacho de toda conta com job retido; devolve o que despachou."""
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
        log.info("dispatch_waiting: %d gravação(ões) despachada(s)", len(dispatched))
    return dispatched
