"""Detecção de job de transcrição morto: o server percebe o que o worker GPU não pôde avisar.

Com `max_tries=1`, um worker GPU que morre no meio do `transcribe` (OOM kill, restart, deploy) não
enfileira `transcription_failed`, e a gravação ficaria `processing` para sempre. O cron
`reap_stalled_jobs` do worker CPU cruza três sinais por job em aberto — o estado no arq, o hash de
progresso e o heartbeat do worker GPU — e marca como falha **recuperável** o que não tem mais quem
o termine — inclusive o `transcribe` concluído cuja ingestão nunca chegou (`ingest_failed`).
Regras em docs/standards/api/jobs-transcricao.md §Job morto.

Nada é marcado na primeira vez que parece morto: a suspeita fica registrada no Redis e só vira
falha se continuar igual depois da graça (`job_grace_seconds`), o que cobre o worker que acabou
de pegar o job e ainda não publicou progresso nem heartbeat.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from arq.jobs import Job, JobResult, JobStatus
from sqlalchemy import select

from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.queue import GPU_HEALTH_KEY, GPU_QUEUE, progress_key, transcribe_job_id
from eclume_server.transcripts import fail

if TYPE_CHECKING:
    from uuid import UUID

    from arq.connections import ArqRedis
    from sqlalchemy.ext.asyncio import AsyncEngine

    from eclume_server.config import Settings

log = logging.getLogger(__name__)

WORKER_LOST = "worker_lost"
JOB_LOST = "job_lost"
JOB_STALLED = "job_stalled"
# A transcrição ficou pronta no worker GPU, mas a ingestão no worker CPU falhou ou nunca aconteceu.
INGEST_FAILED = "ingest_failed"
INGEST_FAILED_MESSAGE = "A transcrição ficou pronta, mas não foi possível gravá-la. Tente de novo."
# Falhas passageiras: retentar (retranscrever ou `POST /admin/jobs/{id}/retry`) tende a resolver.
RETRYABLE_CODES = frozenset(
    {
        WORKER_LOST,
        JOB_LOST,
        JOB_STALLED,
        INGEST_FAILED,
        "gpu_oom",
        "out_of_memory",
        "audio_download_failed",
        "upload_failed",
    }
)
_MESSAGES = {
    WORKER_LOST: "O worker de transcrição parou no meio do job. Tente de novo.",
    JOB_LOST: "O job de transcrição sumiu da fila sem resposta. Tente de novo.",
    JOB_STALLED: "A transcrição ficou parada, sem progresso, além do tempo máximo. Tente de novo.",
    INGEST_FAILED: INGEST_FAILED_MESSAGE,
}
_SUSPECT_PREFIX = "eclume:reaper:suspect:"


def is_retryable(code: str | None) -> bool:
    """Se a falha de código `code` é passageira."""
    return code in RETRYABLE_CODES


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _decode(values: dict[Any, Any]) -> dict[str, str]:
    return {
        (k.decode() if isinstance(k, bytes) else k): (v.decode() if isinstance(v, bytes) else v)
        for k, v in values.items()
    }


def _diagnose_complete(result: JobResult | None, *, now: datetime, settings: Settings) -> str | None:
    """O `transcribe` terminou no arq, mas o job segue em aberto no banco."""
    if result is None:
        return None
    # Falha no arq: o worker morreu e o retry do arq (max_tries=1) encerrou o job sem
    # `transcription_failed`.
    if not result.success:
        return WORKER_LOST
    # Sucesso: a ingestão pode estar na fila `eclume:default`; passado o teto, não está mais (a
    # que falha já marca `ingest_failed` sozinha; isto cobre a que se perdeu).
    finished = result.finish_time if result.finish_time.tzinfo else result.finish_time.replace(tzinfo=UTC)
    return INGEST_FAILED if now - finished > timedelta(seconds=settings.job_stall_seconds) else None


async def diagnose(  # noqa: PLR0913 — os três sinais e o relógio entram explícitos, para o teste
    redis: ArqRedis,
    job_id: str,
    *,
    recording_id: UUID,
    beat: dict[str, str] | None,
    now: datetime,
    settings: Settings,
) -> str | None:
    """O código de falha que o job merece agora, ou `None` se ele ainda tem quem o termine."""
    job = Job(job_id, redis, _queue_name=GPU_QUEUE)
    status = await job.status()
    if status in {JobStatus.queued, JobStatus.deferred}:
        return None  # fila atrasada não é falha
    if status == JobStatus.complete:
        return _diagnose_complete(await job.result_info(), now=now, settings=settings)

    progress = _decode(await redis.hgetall(progress_key(recording_id)))
    if status == JobStatus.not_found and not progress:
        return JOB_LOST
    updated = _parse(progress.get("updated_at"))
    if updated is not None and now - updated > timedelta(seconds=settings.job_stall_seconds):
        return JOB_STALLED
    worker_idle = beat is None or beat.get("busy") != "1"
    silent = updated is None or now - updated > timedelta(seconds=settings.job_grace_seconds)
    if worker_idle and silent:
        return WORKER_LOST
    return None


async def _confirmed(redis: ArqRedis, job_key: str, code: str | None, now: datetime, grace: float) -> bool:
    """Registra a suspeita; confirma só a que dura a graça inteira com o mesmo diagnóstico."""
    key = _SUSPECT_PREFIX + job_key
    if code is None:
        await redis.delete(key)
        return False
    raw = await redis.get(key)
    first = raw.decode() if isinstance(raw, bytes) else raw
    if first is None or not first.startswith(f"{code}|"):
        await redis.set(key, f"{code}|{now.timestamp()}", ex=int(grace * 10) + 60)
        return False
    since = datetime.fromtimestamp(float(first.split("|", 1)[1]), UTC)
    if now - since < timedelta(seconds=grace):
        return False
    await redis.delete(key)
    return True


async def reap(engine: AsyncEngine, redis: ArqRedis, settings: Settings, now: datetime | None = None) -> list[str]:
    """Marca como falha recuperável os jobs sem quem os termine; devolve o que marcou, para o log."""
    now = now or datetime.now(UTC)
    grace = timedelta(seconds=settings.job_grace_seconds)
    jobs = t.transcription_jobs
    async with system_tx(engine) as conn:
        rows = (
            await conn.execute(
                select(jobs.c.id, jobs.c.recording_id, jobs.c.revision).where(
                    jobs.c.state.in_(["queued", "running"]), jobs.c.queued_at <= now - grace
                )
            )
        ).all()
    if not rows:
        return []
    raw_beat = await redis.hgetall(GPU_HEALTH_KEY)
    beat = _decode(raw_beat) if raw_beat else None
    reaped = []
    for job_row_id, recording_id, revision in rows:
        job_key = transcribe_job_id(recording_id, revision)
        code = await diagnose(redis, job_key, recording_id=recording_id, beat=beat, now=now, settings=settings)
        if not await _confirmed(redis, job_key, code, now, settings.job_grace_seconds):
            continue
        async with system_tx(engine) as conn:
            result = await fail(conn, recording_id, code, _MESSAGES[code])
        await redis.delete(progress_key(recording_id))
        log.warning("job %s (gravação %s): %s — %s", job_row_id, recording_id, code, result)
        reaped.append(f"{recording_id}: {code}")
    return reaped
