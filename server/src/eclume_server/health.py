"""Saúde para o painel admin: filas arq, heartbeat do worker GPU, jobs em andamento e falhas.

Regras em docs/standards/code/server-admin.md. As filas, a GPU, os jobs e as falhas são da
plataforma; nada do conteúdo dos usuários sai daqui (o título da gravação, nunca).
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select

from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.pagination import iso
from eclume_server.queue import DEFAULT_QUEUE, GPU_QUEUE, job_progress
from eclume_server.stalled import is_retryable

if TYPE_CHECKING:
    from eclume_server.context import AppContext

log = logging.getLogger(__name__)

FAILURE_WINDOW = timedelta(hours=24)
MAX_FAILURES = 20
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


async def admin_health(ctx: AppContext) -> dict[str, Any]:
    """Schema `AdminHealth`."""
    now = datetime.now(UTC)
    beat = await ctx.queue.gpu_health()
    queues = []
    for name in (GPU_QUEUE, DEFAULT_QUEUE):
        queued, running = await ctx.queue.depth(name)
        queues.append({"name": name, "queued": queued, "running": running})

    jobs = t.transcription_jobs
    # Com o papel de conexão: os jobs são de todos os usuários.
    async with system_tx(ctx.engine) as conn:
        open_jobs = (
            (await conn.execute(select(jobs).where(jobs.c.state.in_(["queued", "running"])).order_by(jobs.c.queued_at)))
            .mappings()
            .all()
        )
        failed_filter = (
            jobs.c.state == "failed",
            jobs.c.finished_at >= now - FAILURE_WINDOW,
        )
        failed_count = (await conn.execute(select(func.count()).select_from(jobs).where(*failed_filter))).scalar_one()
        failures = (
            (
                await conn.execute(
                    select(jobs).where(*failed_filter).order_by(jobs.c.finished_at.desc()).limit(MAX_FAILURES)
                )
            )
            .mappings()
            .all()
        )
    progress = await ctx.queue.raw_progress([row["recording_id"] for row in open_jobs])

    running_jobs = []
    for row in open_jobs:
        raw = progress.get(row["recording_id"])
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
        "recent_failures": [
            {
                "job_id": str(row["id"]),
                "recording_id": str(row["recording_id"]),
                "stage": None,
                "code": row["error_code"] or "internal_error",
                "message": row["error_message"] or "",
                "failed_at": iso(row["finished_at"]),
                "retryable": is_retryable(row["error_code"]),
            }
            for row in failures
        ],
        "checked_at": iso(now),
        "worker": worker_json(beat),
        "queues": queues,
        "running_jobs": running_jobs,
    }
