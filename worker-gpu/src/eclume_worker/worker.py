"""arq `WorkerSettings` for the GPU worker: `eclume:gpu` queue, one job at a time.

```bash
arq eclume_worker.worker.WorkerSettings
```

Importing this module loads neither torch nor WhisperX: the engine imports them on the first job.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

from arq.connections import RedisSettings
from arq.worker import func

from eclume_engines.logs import configure_logs
from eclume_engines.queue_codec import deserialize
from eclume_engines.vram import VramMonitor
from eclume_worker.config import GPU_QUEUE, WorkerConfig
from eclume_worker.health import heartbeat_loop, withdraw
from eclume_worker.jobs import EngineRegistry, transcribe
from eclume_worker.storage import ArtifactStore

if TYPE_CHECKING:
    from collections.abc import Callable

logger = logging.getLogger(__name__)

CONFIG = WorkerConfig.from_env()
IDLE_CHECK_SECONDS = 30.0


def _rss_mb() -> float:
    """Process RSS in MiB (`VmRSS` from /proc); 0 where /proc does not exist."""
    try:
        with Path("/proc/self/status").open(encoding="ascii") as status:
            for line in status:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024
    except OSError:
        pass
    return 0.0


def _terminate_process() -> None:
    """Ask for a clean shutdown: SIGTERM is the deploy path (it drains and withdraws the heartbeat)."""
    os.kill(os.getpid(), signal.SIGTERM)


async def idle_unloader(
    registry: EngineRegistry,
    idle_seconds: float,
    every: float = IDLE_CHECK_SECONDS,
    *,
    recycle: bool = False,
    terminate: Callable[[], None] = _terminate_process,
) -> None:
    """Unload the models after `idle_seconds` without a job, giving the VRAM back to the host.

    With `recycle`, and if torch was imported in the process, exit the process afterwards (the
    `restart: unless-stopped` brings up a new one, without torch) to give the RAM back too.
    """
    while True:
        await asyncio.sleep(every)
        if await asyncio.to_thread(registry.unload_if_idle, idle_seconds):
            logger.info("models unloaded after %.0f s idle", idle_seconds)
            if recycle and "torch" in sys.modules and not registry.busy:
                logger.info("recycling the process to give the memory back (RSS %.0f MiB)", _rss_mb())
                terminate()
                return


async def startup(ctx: dict[str, Any]) -> None:
    """Set up the log, S3, the engine, the idle unload and the heartbeat."""
    configure_logs()
    ctx["config"] = CONFIG
    ctx["store"] = ArtifactStore.from_config(CONFIG)
    ctx["engines"] = registry = EngineRegistry(CONFIG)
    ctx["idle_task"] = asyncio.create_task(
        idle_unloader(registry, CONFIG.model_idle_seconds, recycle=CONFIG.recycle_on_idle)
    )
    ctx["heartbeat_task"] = asyncio.create_task(heartbeat_loop(ctx["redis"], CONFIG, registry, VramMonitor()))


async def shutdown(ctx: dict[str, Any]) -> None:
    """Stop the idle unload and the heartbeat, withdraw the heartbeat and free the GPU."""
    for name in ("idle_task", "heartbeat_task"):
        task = ctx.get(name)
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
    if "redis" in ctx:
        await withdraw(ctx["redis"])
    registry = ctx.get("engines")
    if registry is not None:
        await asyncio.to_thread(registry.unload)


class WorkerSettings:
    """Configuration read by the arq CLI."""

    functions = (func(transcribe, name="transcribe", max_tries=1, timeout=CONFIG.job_timeout_seconds),)
    queue_name = GPU_QUEUE
    max_jobs = 1
    max_tries = 1
    job_timeout = CONFIG.job_timeout_seconds
    # On SIGTERM (deploy), arq stops taking jobs and waits for the current one to finish up to the
    # job ceiling: the deploy drains the GPU worker without killing a transcription in progress. The
    # compose `stop_grace_period` covers the deploy's `stop -t`.
    job_completion_wait = CONFIG.job_timeout_seconds
    # A one-job-at-a-time queue with jobs of minutes: polling Redis every 2 s (default 0.5 s) is enough.
    poll_delay = 2.0
    # Phase A of the pickle-free queue (holetz/eclume#94): reads JSON and the old pickle with no globals.
    job_deserializer = deserialize
    redis_settings = RedisSettings.from_dsn(CONFIG.redis_url)
    on_startup = startup
    on_shutdown = shutdown
