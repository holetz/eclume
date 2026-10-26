"""GPU worker heartbeat: `HSET eclume:gpu:health` every 15 s, with a 45 s TTL.

The server reads the hash for `/admin/health` and for the reaper (contract in
docs/standards/api/jobs-transcricao.md). Without the hash, the worker has been stopped for more than
45 s. `busy` holds from the start to the end of a `transcribe`, and `job_id` is its `_job_id`
(absent from the hash when idle). Without NVML (CPU engine), the GPU fields are left out.
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
    """The hash content, all as text."""
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
    """Write a heartbeat; the GPU fields go out whole each time (the hash is replaced)."""
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
    """Publish until cancelled; a failure only goes to the log, and the next round tries again."""
    while True:
        try:
            await publish(redis, config, registry, vram)
        except Exception:
            logger.exception("GPU worker heartbeat failed")
        await asyncio.sleep(every)


async def withdraw(redis: Any) -> None:  # noqa: ANN401 — ArqRedis
    """Delete the heartbeat on shutdown, so health shows the worker stopped right away."""
    with contextlib.suppress(Exception):
        await redis.delete(HEALTH_KEY)


async def alive(redis_url: str) -> bool:
    """The `eclume:gpu:health` heartbeat exists (the worker published within the last 45 s)."""
    client = Redis.from_url(redis_url)
    try:
        return bool(await client.exists(HEALTH_KEY))
    finally:
        await client.aclose()


def main(argv: list[str] | None = None) -> int:
    """`python -m eclume_worker.health --probe`: exit 0 with a heartbeat, 1 without; the compose healthcheck."""
    parser = argparse.ArgumentParser(prog="python -m eclume_worker.health")
    # `--sonda` is the former name, still used by deploy/docker-compose.prod.yml until the deploy specs rename it.
    parser.add_argument(
        "--probe", "--sonda", dest="probe", action="store_true", required=True, help="check the heartbeat and exit 0/1"
    )
    parser.parse_args(argv)
    try:
        return 0 if asyncio.run(alive(WorkerConfig.from_env().redis_url)) else 1
    except Exception:  # noqa: BLE001 — Redis down means a worker with no signal
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
