"""Heartbeat do worker GPU: `HSET eclume:gpu:health` a cada 15 s, com TTL de 45 s.

O server lê o hash para `/admin/health` e para o reaper (contrato em
docs/standards/api/jobs-transcricao.md). Sem o hash, o worker está parado há mais de 45 s. `busy` vale
do início ao fim de um `transcribe`, e `job_id` é o `_job_id` dele (fora do hash quando ocioso). Sem
NVML (engine CPU), os campos da GPU ficam de fora.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from redis.asyncio import Redis

from eclume_engines import DEFAULT_ENGINE
from eclume_worker import __version__
from eclume_worker.config import WorkerConfig

if TYPE_CHECKING:
    from eclume_engines.vram import VramMonitor
    from eclume_worker.jobs import EngineRegistry

logger = logging.getLogger(__name__)

HEALTH_KEY = "eclume:gpu:health"
HEARTBEAT_SECONDS = 15.0
HEALTH_TTL_SECONDS = 45


def heartbeat_fields(
    config: WorkerConfig, registry: EngineRegistry, gpu: dict[str, Any] | None, now: datetime
) -> dict[str, str]:
    """O conteúdo do hash, todo em texto."""
    fields = {
        "updated_at": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "worker_version": __version__,
        "engine": config.engine or registry.current_name or DEFAULT_ENGINE,
        "device": config.device,
        "busy": "1" if registry.busy else "0",
        "models": json.dumps(registry.loaded_models()),
    }
    if registry.current_job is not None:
        fields["job_id"] = registry.current_job
    if gpu is not None:
        fields |= {name: str(value) for name, value in gpu.items()}
    return fields


async def publish(redis: Any, config: WorkerConfig, registry: EngineRegistry, vram: VramMonitor) -> None:  # noqa: ANN401 — ArqRedis
    """Grava um heartbeat; os campos da GPU saem inteiros a cada vez (o hash é substituído)."""
    gpu = await asyncio.to_thread(vram.snapshot)
    fields = heartbeat_fields(config, registry, gpu, datetime.now(UTC))
    pipe = redis.pipeline(transaction=True)
    pipe.delete(HEALTH_KEY)
    pipe.hset(HEALTH_KEY, mapping=fields)
    pipe.expire(HEALTH_KEY, HEALTH_TTL_SECONDS)
    await pipe.execute()


async def heartbeat_loop(
    redis: Any,  # noqa: ANN401 — ArqRedis
    config: WorkerConfig,
    registry: EngineRegistry,
    vram: VramMonitor,
    every: float = HEARTBEAT_SECONDS,
) -> None:
    """Publica até ser cancelado; uma falha só vai para o log, e a próxima volta tenta de novo."""
    while True:
        try:
            await publish(redis, config, registry, vram)
        except Exception:
            logger.exception("heartbeat do worker GPU falhou")
        await asyncio.sleep(every)


async def withdraw(redis: Any) -> None:  # noqa: ANN401 — ArqRedis
    """Apaga o heartbeat no desligamento, para a saúde mostrar o worker parado na hora."""
    with contextlib.suppress(Exception):
        await redis.delete(HEALTH_KEY)


async def alive(redis_url: str) -> bool:
    """O heartbeat `eclume:gpu:health` existe (o worker publicou nos últimos 45 s)."""
    client = Redis.from_url(redis_url)
    try:
        return bool(await client.exists(HEALTH_KEY))
    finally:
        await client.aclose()


def main(argv: list[str] | None = None) -> int:
    """`python -m eclume_worker.health --sonda`: sai 0 com heartbeat, 1 sem; healthcheck do compose."""
    parser = argparse.ArgumentParser(prog="python -m eclume_worker.health")
    parser.add_argument("--sonda", action="store_true", required=True, help="confere o heartbeat e sai 0/1")
    parser.parse_args(argv)
    try:
        return 0 if asyncio.run(alive(WorkerConfig.from_env().redis_url)) else 1
    except Exception:  # noqa: BLE001 — Redis fora é worker sem sinal
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
