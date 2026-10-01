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
from typing import Any

from arq.connections import RedisSettings
from arq.worker import func

from eclume_engines.fila import desserializar
from eclume_engines.vram import VramMonitor
from eclume_worker.config import GPU_QUEUE, WorkerConfig
from eclume_worker.health import heartbeat_loop, withdraw
from eclume_worker.jobs import EngineRegistry, transcribe
from eclume_worker.storage import ArtifactStore

logger = logging.getLogger(__name__)

CONFIG = WorkerConfig.from_env()
IDLE_CHECK_SECONDS = 30.0


async def idle_unloader(registry: EngineRegistry, idle_seconds: float, every: float = IDLE_CHECK_SECONDS) -> None:
    """Descarrega os modelos depois de `idle_seconds` sem job, devolvendo a VRAM ao host."""
    while True:
        await asyncio.sleep(every)
        if await asyncio.to_thread(registry.unload_if_idle, idle_seconds):
            logger.info("modelos descarregados após %.0f s ociosos", idle_seconds)


def configure_logging(level: int = logging.INFO) -> None:
    """Log do worker e das engines no stderr; o CLI do arq só configura o logger `arq`."""
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s", "%H:%M:%S"))
    for name in ("eclume_worker", "eclume_engines"):
        named = logging.getLogger(name)
        if not named.handlers:
            named.addHandler(handler)
            named.setLevel(level)
            named.propagate = False


async def startup(ctx: dict[str, Any]) -> None:
    """Prepara o log, o S3, a engine, a descarga por ociosidade e o heartbeat."""
    configure_logging()
    ctx["config"] = CONFIG
    ctx["store"] = ArtifactStore.from_config(CONFIG)
    ctx["engines"] = registry = EngineRegistry(CONFIG)
    ctx["idle_task"] = asyncio.create_task(idle_unloader(registry, CONFIG.model_idle_seconds))
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
