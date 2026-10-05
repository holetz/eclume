"""Retomada da cadeia por agente: o que nunca chegou à fila volta sozinho.

O commit seguido do enfileiramento continua sendo o caminho; se o Redis oscilou ou o worker parou
entre os dois, a etapa ficaria `pending` para sempre. O cron `resume_pipelines` (a cada 5 min,
`unique`) relê o estado no banco e relança pelo `_job_id` determinístico, que o arq deduplica:

- na revisão atual com o job de transcrição `succeeded` há mais de `RESUME_AFTER` e a etapa
  `speakers` fora de `waiting` (a gravação parada à espera dos nomes não é relançada): tipo de agenda
  sem linha → `detect_agenda_type`; tipo final e campos sem linha → `fill_fields`; campos finais e
  resumo sem linha → o resumo automático (sem refazer os campos);
- resumo `queued`/`running` há mais de `RESUME_AFTER`: sumido do arq → reenfileirado; concluído no
  arq com o resumo ainda aberto → `failed` (`internal_error`). O que o arq ainda conhece (na fila,
  adiado, rodando) nunca é tocado.

Regras em docs/standards/code/processamento-automatico.md §Retomada.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from arq.jobs import Job, JobStatus
from sqlalchemy import and_, select

from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.pipeline import FINISHED
from eclume_server.queue import AGENT_QUEUE, enqueue_summary, step_job_id, summarize_job_id
from eclume_server.summaries import INTERNAL_ERROR, fail_summary, start_auto_summary

if TYPE_CHECKING:
    from uuid import UUID

    from arq.connections import ArqRedis
    from sqlalchemy.ext.asyncio import AsyncEngine

log = logging.getLogger(__name__)

RESUME_AFTER = timedelta(minutes=5)
# Relançamentos por passada, os mais antigos primeiro.
RESUME_LIMIT = 50
LOST_SUMMARY_MESSAGE = "O resumo terminou sem resposta do agente. Gere de novo."


def _joined_step(latest: Any, name: str) -> tuple[Any, Any]:  # noqa: ANN401 — Core do SQLAlchemy
    """O alias de `pipeline_steps` da etapa `name` e a condição que o liga à revisão de `latest`."""
    step = t.pipeline_steps.alias(f"step_{name}")
    on = and_(step.c.recording_id == latest.c.recording_id, step.c.revision == latest.c.revision, step.c.step == name)
    return step, on


async def _stalled_chains(engine: AsyncEngine, cutoff: datetime) -> list[tuple[UUID, int, str]]:
    """`(gravação, revisão, o que relançar)` da revisão atual, com a transcrição pronta antes de `cutoff`."""
    jobs = t.transcription_jobs
    latest = select(jobs.c.recording_id, jobs.c.revision, jobs.c.state, jobs.c.finished_at).distinct(
        jobs.c.recording_id
    )
    latest = latest.order_by(jobs.c.recording_id, jobs.c.revision.desc()).subquery()
    speakers, speakers_on = _joined_step(latest, "speakers")
    agenda, agenda_on = _joined_step(latest, "agenda_type")
    fields, fields_on = _joined_step(latest, "fields")
    summary, summary_on = _joined_step(latest, "summary")
    query = (
        select(latest.c.recording_id, latest.c.revision, agenda.c.state, fields.c.state)
        .select_from(
            latest.outerjoin(speakers, speakers_on)
            .outerjoin(agenda, agenda_on)
            .outerjoin(fields, fields_on)
            .outerjoin(summary, summary_on)
        )
        .where(
            latest.c.state == "succeeded",
            latest.c.finished_at <= cutoff,
            summary.c.id.is_(None),
            # Parada à espera de nomear os locutores: quem a solta enfileira o tipo.
            speakers.c.state.is_distinct_from("waiting"),
        )
        .order_by(latest.c.finished_at)
    )
    async with system_tx(engine) as conn:
        rows = (await conn.execute(query)).all()
    chains = []
    for recording_id, revision, agenda_state, fields_state in rows:
        if agenda_state is None:
            chains.append((recording_id, revision, "detect_agenda_type"))
        elif agenda_state in FINISHED and fields_state is None:
            chains.append((recording_id, revision, "fill_fields"))
        elif fields_state in FINISHED:
            chains.append((recording_id, revision, "summary"))
    return chains


async def _resume_chain(engine: AsyncEngine, redis: ArqRedis, recording_id: UUID, revision: int, job: str) -> None:
    if job != "summary":
        await redis.enqueue_job(
            job,
            str(recording_id),
            revision,
            _job_id=step_job_id(job, recording_id, revision),
            _queue_name=AGENT_QUEUE,
        )
        return
    async with system_tx(engine) as conn:
        summary_id = await start_auto_summary(conn, recording_id, revision)
    if summary_id is not None:
        await enqueue_summary(redis, summary_id)


async def _open_summaries(engine: AsyncEngine, cutoff: datetime) -> list[tuple[UUID, int]]:
    s = t.summaries.c
    async with system_tx(engine) as conn:
        query = (
            select(s.id, s.attempts)
            .where(s.status.in_(["queued", "running"]), s.created_at <= cutoff)
            .order_by(s.created_at)
        )
        return [(row.id, row.attempts) for row in await conn.execute(query)]


async def resume(
    engine: AsyncEngine, redis: ArqRedis, now: datetime | None = None, limit: int = RESUME_LIMIT
) -> list[str]:
    """Uma passada da retomada; devolve o que relançou ou fechou, para o log."""
    cutoff = (now or datetime.now(UTC)) - RESUME_AFTER
    done: list[str] = []
    for recording_id, revision, job in await _stalled_chains(engine, cutoff):
        if len(done) >= limit:
            return done
        await _resume_chain(engine, redis, recording_id, revision, job)
        log.warning("retomada: %s da gravação %s (revisão %d) relançado", job, recording_id, revision)
        done.append(f"{recording_id}: {job}")
    for summary_id, attempts in await _open_summaries(engine, cutoff):
        if len(done) >= limit:
            return done
        status = await Job(summarize_job_id(summary_id), redis, _queue_name=AGENT_QUEUE).status()
        if status == JobStatus.not_found:
            await enqueue_summary(redis, summary_id)
            log.warning("retomada: resumo %s sumido do arq reenfileirado", summary_id)
            done.append(f"{summary_id}: summarize")
        elif status == JobStatus.complete:
            await fail_summary(engine, summary_id, INTERNAL_ERROR, LOST_SUMMARY_MESSAGE, attempts)
            log.warning("retomada: resumo %s concluído no arq sem fechar; marcado falho", summary_id)
            done.append(f"{summary_id}: failed")
    return done
