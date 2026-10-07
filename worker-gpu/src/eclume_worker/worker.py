"""`WorkerSettings` do arq para o worker GPU: fila `eclume:gpu`, um job por vez.

```bash
arq eclume_worker.worker.WorkerSettings
```

Importar este módulo não carrega torch nem WhisperX: a engine os importa no primeiro job.
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

from eclume_engines.fila import desserializar
from eclume_engines.registro import configurar_logs
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
    """RSS do processo em MiB (`VmRSS` de /proc); 0 onde o /proc não existe."""
    try:
        with Path("/proc/self/status").open(encoding="ascii") as status:
            for line in status:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024
    except OSError:
        pass
    return 0.0


def _encerrar_processo() -> None:
    """Pede o encerramento limpo: o SIGTERM é o caminho do deploy (drena e retira o heartbeat)."""
    os.kill(os.getpid(), signal.SIGTERM)


async def idle_unloader(
    registry: EngineRegistry,
    idle_seconds: float,
    every: float = IDLE_CHECK_SECONDS,
    *,
    recycle: bool = False,
    terminate: Callable[[], None] = _encerrar_processo,
) -> None:
    """Descarrega os modelos depois de `idle_seconds` sem job, devolvendo a VRAM ao host.

    Com `recycle`, e se o torch foi importado no processo, encerra o processo em seguida (o
    `restart: unless-stopped` sobe um novo, sem torch) para devolver também a RAM.
    """
    while True:
        await asyncio.sleep(every)
        if await asyncio.to_thread(registry.unload_if_idle, idle_seconds):
            logger.info("modelos descarregados após %.0f s ociosos", idle_seconds)
            if recycle and "torch" in sys.modules and not registry.busy:
                logger.info("reciclando o processo para devolver a memória (RSS %.0f MiB)", _rss_mb())
                terminate()
                return


async def startup(ctx: dict[str, Any]) -> None:
    """Prepara o log, o S3, a engine, a descarga por ociosidade e o heartbeat."""
    configurar_logs()
    ctx["config"] = CONFIG
    ctx["store"] = ArtifactStore.from_config(CONFIG)
    ctx["engines"] = registry = EngineRegistry(CONFIG)
    ctx["idle_task"] = asyncio.create_task(
        idle_unloader(registry, CONFIG.model_idle_seconds, recycle=CONFIG.recycle_on_idle)
    )
    ctx["heartbeat_task"] = asyncio.create_task(heartbeat_loop(ctx["redis"], CONFIG, registry, VramMonitor()))


async def shutdown(ctx: dict[str, Any]) -> None:
    """Para a descarga ociosa e o heartbeat, retira o heartbeat e libera a GPU."""
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
    """Configuração lida pelo CLI do arq."""

    functions = (func(transcribe, name="transcribe", max_tries=1, timeout=CONFIG.job_timeout_seconds),)
    queue_name = GPU_QUEUE
    max_jobs = 1
    max_tries = 1
    job_timeout = CONFIG.job_timeout_seconds
    # No SIGTERM (deploy), o arq para de pegar jobs e espera o atual terminar até o teto do job: o
    # deploy drena o worker GPU sem matar transcrição em curso. O `stop_grace_period` do compose
    # cobre o `stop -t` do deploy.
    job_completion_wait = CONFIG.job_timeout_seconds
    # Fase A da fila sem pickle (holetz/eclume#94): lê JSON e o pickle antigo sem globais.
    job_deserializer = desserializar
    redis_settings = RedisSettings.from_dsn(CONFIG.redis_url)
    on_startup = startup
    on_shutdown = shutdown
