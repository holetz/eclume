"""Saúde para o painel admin: filas, worker GPU, jobs, etapas do pipeline, serviços e falhas.

Regras em docs/standards/code/server-admin.md. As filas, a GPU, os jobs, as etapas e as falhas são
da plataforma; nada do conteúdo dos usuários sai daqui (o título da gravação, nunca): só números e
códigos de erro.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import Boolean, Column, MetaData, Table, Text, func, select

from eclume_server import __version__
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.dispatch import held_counts
from eclume_server.pagination import iso
from eclume_server.queue import AGENT_QUEUE, DEFAULT_QUEUE, GPU_QUEUE, job_progress, progress_of_revision
from eclume_server.stalled import is_retryable

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.context import AppContext

log = logging.getLogger(__name__)
# O catálogo do Postgres, só as colunas que a sonda lê.
t_pg_class = Table(
    "pg_class", MetaData(), Column("relname", Text), Column("relkind", Text), Column("relforcerowsecurity", Boolean)
)

FAILURE_WINDOW = timedelta(hours=24)
MAX_FAILURES = 20
# As etapas que rodam (o recebido é instantâneo), na ordem do pipeline.
HEALTH_STEPS = ("preprocessing", "transcription", "fields", "agenda_type", "summary")
# Etapas cuja falha é do job de transcrição, que o admin retenta.
JOB_STEPS = ("preprocessing", "transcription")
PROBE_TIMEOUT_S = 2.0
STORAGE_SLOW_S = 1.0
# Chave de health-check do arq do worker CPU (`health_check_interval` no `worker_settings`).
CPU_HEALTH_KEY = f"{DEFAULT_QUEUE}:health-check"
# A do worker de agentes: a sonda `cpu_worker` exige as duas.
AGENT_HEALTH_KEY = f"{AGENT_QUEUE}:health-check"


class ProbeDownError(Exception):
    """A sonda achou o serviço fora; a mensagem vira o `detail`."""


# Tabelas do usuário: a RLS forçada em todas é o "RLS ativa" do Postgres.
USER_TABLES = (
    "recordings",
    "uploads",
    "collections",
    "agenda_types",
    "fields",
    "field_values",
    "pipeline_steps",
    "people",
    "transcription_jobs",
    "transcripts",
    "speakers",
    "segments",
    "speaker_embeddings",
    "summaries",
    "voice_samples",
    "speaker_suggestions",
)
# O admin não vê conteúdo de usuário: no lugar do título da gravação, um rótulo fixo.
RECORDING_TITLE = "Gravação de usuário"


def _int(value: str | None) -> int | None:
    try:
        return None if value in {None, ""} else int(float(value))
    except ValueError:
        return None


def worker_json(beat: dict[str, str] | None) -> dict[str, Any] | None:
    """Bloco `worker` do `AdminHealth`, do hash `eclume:gpu:health`."""
    if beat is None:
        return None
    return {
        "online": True,
        "last_seen_at": beat.get("updated_at"),
        "version": beat.get("worker_version") or None,
        "engine": beat.get("engine") or None,
        "device": beat.get("device") or None,
        "busy": beat.get("busy") == "1",
    }


def gpu_json(beat: dict[str, str] | None) -> dict[str, Any] | None:
    """Bloco `gpu`; `null` sem heartbeat ou sem NVML (engine CPU)."""
    if not beat or not beat.get("gpu_name"):
        return None
    try:
        utilization = float(beat.get("utilization_pct") or 0)
    except ValueError:
        utilization = 0.0
    return {
        "name": beat["gpu_name"],
        "vram_total_mb": _int(beat.get("vram_total_mb")) or 0,
        "vram_used_mb": _int(beat.get("vram_used_mb")) or 0,
        "utilization_pct": max(0.0, min(utilization, 100.0)),
    }


def models_json(beat: dict[str, str] | None) -> list[dict[str, Any]]:
    """`models_loaded`: o modelo residente que o worker declarou, se houver."""
    if not beat or not beat.get("models"):
        return []
    try:
        models = json.loads(beat["models"])
    except ValueError:
        log.warning("heartbeat do worker GPU com `models` ilegível: %r", beat["models"])
        return []
    return [
        {"name": m["name"], "kind": m["kind"], "loaded_at": m["loaded_at"], "vram_mb": m.get("vram_mb")}
        for m in models
        if isinstance(m, dict) and {"name", "kind", "loaded_at"} <= m.keys()
    ]


async def steps_json(conn: AsyncConnection, since: datetime) -> list[dict[str, Any]]:
    """`steps`: execuções, mediana (ms) e falhas de cada etapa nas últimas 24 h, só números."""
    ps = t.pipeline_steps.c
    finished = ps.state.in_(["done", "failed"])
    rows = (
        await conn.execute(
            select(
                ps.step,
                func.count().filter(finished),
                func.percentile_cont(0.5).within_group(ps.duration_ms).filter(ps.state == "done"),
                func.count().filter(ps.state == "failed"),
            )
            .where(ps.finished_at >= since, ps.step != "received")
            .group_by(ps.step)
        )
    ).all()
    found = {step: (runs, median, failures) for step, runs, median, failures in rows}
    items = []
    for step in HEALTH_STEPS:
        runs, median, failures = found.get(step, (0, None, 0))
        items.append(
            {"step": step, "runs": runs, "median_ms": None if median is None else round(median), "failures": failures}
        )
    return items


async def failures_json(conn: AsyncConnection, since: datetime) -> list[dict[str, Any]]:
    """`recent_failures`: as etapas que falharam nas últimas 24 h; o job só nas da transcrição."""
    ps, jobs = t.pipeline_steps.c, t.transcription_jobs.c
    rows = (
        await conn.execute(
            select(ps.recording_id, ps.step, ps.error_code, ps.error_message, ps.finished_at, jobs.id.label("job_id"))
            .outerjoin(
                t.transcription_jobs,
                (jobs.recording_id == ps.recording_id) & (jobs.revision == ps.revision) & ps.step.in_(JOB_STEPS),
            )
            .where(ps.state == "failed", ps.finished_at >= since)
            .order_by(ps.finished_at.desc())
            .limit(MAX_FAILURES)
        )
    ).all()
    return [
        {
            "job_id": str(row.job_id) if row.job_id else None,
            "recording_id": str(row.recording_id),
            "step": row.step,
            "stage": None,
            "code": row.error_code or "internal_error",
            "message": row.error_message or "",
            "failed_at": iso(row.finished_at),
            "retryable": row.job_id is not None and is_retryable(row.error_code),
        }
        for row in rows
    ]


async def _probe(name: str, check: Callable[[], Awaitable[str | None]], slow_s: float | None = None) -> dict[str, Any]:
    """Roda a sonda com teto de 2 s: `healthy`, `degraded` (lenta) ou `down`."""
    started = time.monotonic()
    try:
        async with asyncio.timeout(PROBE_TIMEOUT_S):
            detail = await check()
    except ProbeDownError as exc:
        status, detail = "down", str(exc)
    except Exception as exc:  # noqa: BLE001 — qualquer falha da sonda é o serviço fora
        status, detail = "down", "sem resposta em 2 s" if isinstance(exc, TimeoutError) else type(exc).__name__
    else:
        status = "healthy"
    latency = round((time.monotonic() - started) * 1000)
    if status == "healthy" and slow_s is not None and latency > slow_s * 1000:
        status, detail = "degraded", f"lento: {latency} ms"
    return {"name": name, "status": status, "detail": detail, "latency_ms": latency}


def connected_assistants(count: int) -> str:
    """O detalhe do serviço `mcp` na Saúde."""
    if count == 0:
        return "nenhum assistente conectado nas últimas 24 h"
    if count == 1:
        return "1 assistente conectado nas últimas 24 h"
    return f"{count} assistentes conectados nas últimas 24 h"


async def check_postgres(ctx: AppContext) -> str:
    """Sonda do Postgres: responde e diz se a RLS está forçada nas tabelas do usuário."""
    async with system_tx(ctx.engine) as conn:
        forced = (
            await conn.execute(
                select(func.bool_and(t_pg_class.c.relforcerowsecurity)).where(
                    t_pg_class.c.relname.in_(USER_TABLES), t_pg_class.c.relkind == "r"
                )
            )
        ).scalar()
    return "RLS ativa" if forced else "RLS desligada em alguma tabela do usuário"


async def check_redis(ctx: AppContext) -> None:
    """Sonda do Redis."""
    await ctx.queue.pool.ping()


async def check_storage(ctx: AppContext) -> None:
    """Sonda do armazenamento S3."""
    await ctx.storage.head_bucket()


async def readiness(ctx: AppContext) -> dict[str, Any]:
    """`/health/ready`: as sondas de Postgres, Redis e armazenamento, só com nome e `ok`/`down`.

    Pública: sem latência nem mensagem de erro, que diriam demais a quem não está logado.
    """
    probes = await asyncio.gather(
        _probe("postgres", lambda: check_postgres(ctx)),
        _probe("redis", lambda: check_redis(ctx)),
        _probe("storage", lambda: check_storage(ctx)),
    )
    checks = [{"name": p["name"], "status": "down" if p["status"] == "down" else "ok"} for p in probes]
    return {"status": "down" if any(c["status"] == "down" for c in checks) else "ok", "checks": checks}


async def services_json(ctx: AppContext, beat: dict[str, str] | None) -> list[dict[str, Any]]:
    """`services`: uma sonda por serviço, em paralelo."""

    async def postgres() -> str:
        return await check_postgres(ctx)

    async def redis() -> None:
        await check_redis(ctx)

    async def storage() -> None:
        await check_storage(ctx)

    async def gpu_worker() -> str:
        if beat is None:
            raise LookupError
        return beat.get("engine") or ""

    async def cpu_worker() -> None:
        workers = ((CPU_HEALTH_KEY, DEFAULT_QUEUE), (AGENT_HEALTH_KEY, AGENT_QUEUE))
        missing = [queue for key, queue in workers if not await ctx.queue.pool.exists(key)]
        if missing:
            msg = f"sem worker em {', '.join(missing)}"
            raise ProbeDownError(msg)

    async def api() -> str:
        return __version__

    async def mcp() -> str:
        # Sem estado, não há sessão MCP aberta: conectado é o token usado pelo MCP nas últimas 24 h.
        since = datetime.now(UTC) - FAILURE_WINDOW
        async with system_tx(ctx.engine) as conn:
            count = (
                await conn.execute(select(func.count()).where(t.api_tokens.c.mcp_last_used_at >= since))
            ).scalar_one()
        return connected_assistants(count)

    probes = await asyncio.gather(
        _probe("api", api),
        _probe("postgres", postgres),
        _probe("redis", redis),
        _probe("storage", storage, slow_s=STORAGE_SLOW_S),
        _probe("gpu_worker", gpu_worker),
        _probe("cpu_worker", cpu_worker),
        _probe("mcp", mcp),
    )
    return list(probes)


async def admin_health(ctx: AppContext) -> dict[str, Any]:
    """Schema `AdminHealth`."""
    now = datetime.now(UTC)
    beat = await ctx.queue.gpu_health()
    queues = []
    for name in (GPU_QUEUE, DEFAULT_QUEUE, AGENT_QUEUE):
        queued, running = await ctx.queue.depth(name)
        queues.append({"name": name, "queued": queued, "running": running})

    jobs = t.transcription_jobs
    # Com o papel de conexão: os jobs são de todos os usuários.
    async with system_tx(ctx.engine) as conn:
        open_jobs = (
            # Só os despachados: o retido no banco (vez da conta, janela de minutos) conta em `held_jobs`.
            (
                await conn.execute(
                    select(jobs)
                    .where(jobs.c.state.in_(["queued", "running"]), jobs.c.dispatched_at.is_not(None))
                    .order_by(jobs.c.queued_at)
                )
            )
            .mappings()
            .all()
        )
        failed_filter = (
            jobs.c.state == "failed",
            jobs.c.finished_at >= now - FAILURE_WINDOW,
        )
        failed_count = (await conn.execute(select(func.count()).select_from(jobs).where(*failed_filter))).scalar_one()
        held = await held_counts(conn)
        steps = await steps_json(conn, now - FAILURE_WINDOW)
        failures = await failures_json(conn, now - FAILURE_WINDOW)
    services = await services_json(ctx, beat)
    progress = await ctx.queue.raw_progress([row["recording_id"] for row in open_jobs])

    running_jobs = []
    for row in open_jobs:
        raw = progress_of_revision(progress.get(row["recording_id"]), row["revision"])
        stage, fraction = job_progress(raw) or (None, None)
        running_jobs.append(
            {
                "job_id": str(row["id"]),
                "recording_id": str(row["recording_id"]),
                "recording_title": RECORDING_TITLE,
                "state": "running" if raw else "queued",
                "stage": stage,
                "progress": fraction,
                "queued_at": iso(row["queued_at"]),
                "started_at": (raw or {}).get("started_at") or iso(row["started_at"]),
                "updated_at": (raw or {}).get("updated_at"),
            }
        )
    gpu_queue = queues[0]
    return {
        "queue": {"queued": gpu_queue["queued"], "running": gpu_queue["running"], "failed_last_24h": failed_count},
        "gpu": gpu_json(beat),
        "models_loaded": models_json(beat),
        "recent_failures": failures,
        "steps": steps,
        "services": services,
        "checked_at": iso(now),
        "worker": worker_json(beat),
        "queues": queues,
        "running_jobs": running_jobs,
        "held_jobs": held,
    }
