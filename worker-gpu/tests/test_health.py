"""Heartbeat do worker GPU em `eclume:gpu:health`."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from eclume_engines import EngineOptions
from eclume_worker import __version__
from eclume_worker.config import WorkerConfig
from eclume_worker.health import HEALTH_KEY, HEALTH_TTL_SECONDS, heartbeat_fields, heartbeat_loop, publish, withdraw
from eclume_worker.jobs import EngineRegistry

if TYPE_CHECKING:
    from pathlib import Path

GPU = {
    "gpu_name": "NVIDIA GeForce GTX 1660 SUPER",
    "vram_total_mb": 6144,
    "vram_used_mb": 3120,
    "utilization_pct": 87.0,
}
MODEL = {"name": "large-v3-turbo", "kind": "asr", "loaded_at": "2026-09-25T12:00:00Z", "vram_mb": 2210}


class ResidentEngine:
    name = "whisperx-local"
    hf_token = None

    def transcribe(self, *_args: Any) -> None:
        return None

    def loaded_models(self) -> list[dict[str, Any]]:
        return [MODEL]

    def unload(self) -> None:
        return None


class FakeVram:
    def __init__(self, snapshot: dict[str, Any] | None) -> None:
        self.value = snapshot

    def snapshot(self) -> dict[str, Any] | None:
        return self.value


class Pipeline:
    def __init__(self, redis: FakeRedis) -> None:
        self.redis = redis
        self.ops: list[tuple[str, Any]] = []

    def delete(self, key: str) -> None:
        self.ops.append(("delete", key))

    def hset(self, key: str, mapping: dict[str, str]) -> None:
        self.ops.append(("hset", (key, mapping)))

    def expire(self, key: str, seconds: int) -> None:
        self.ops.append(("expire", (key, seconds)))

    async def execute(self) -> None:
        for op, args in self.ops:
            if op == "delete":
                self.redis.hashes.pop(args, None)
            elif op == "hset":
                self.redis.hashes[args[0]] = dict(args[1])
            else:
                self.redis.ttl[args[0]] = args[1]


class FakeRedis:
    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, str]] = {}
        self.ttl: dict[str, int] = {}

    def pipeline(self, *, transaction: bool) -> Pipeline:
        assert transaction
        return Pipeline(self)

    async def delete(self, key: str) -> None:
        self.hashes.pop(key, None)


def _registry(tmp_path: Path) -> EngineRegistry:
    registry = EngineRegistry(WorkerConfig(), factory=lambda _name, **_kw: ResidentEngine(), hf_token=lambda: None)
    audio = tmp_path / "a.ogg"
    audio.write_bytes(b"x")
    registry.run("whisperx-local", audio, EngineOptions(), lambda _s, _p: None)
    return registry


def test_campos_com_gpu_e_modelo_residente(tmp_path: Path):
    registry = _registry(tmp_path)
    fields = heartbeat_fields(WorkerConfig(), registry, GPU, datetime(2026, 9, 25, 12, 0, 5, tzinfo=UTC))
    assert fields == {
        "updated_at": "2026-09-25T12:00:05Z",
        "worker_version": __version__,
        "engine": "whisperx-local",
        "device": "cuda",
        "busy": "0",
        "models": json.dumps([MODEL]),
        "gpu_name": "NVIDIA GeForce GTX 1660 SUPER",
        "vram_total_mb": "6144",
        "vram_used_mb": "3120",
        "utilization_pct": "87.0",
    }


def test_sem_nvml_sai_sem_gpu_e_a_engine_do_ambiente_vence():
    registry = EngineRegistry(WorkerConfig(), hf_token=lambda: None)
    fields = heartbeat_fields(WorkerConfig(engine="cpu", device="cpu"), registry, None, datetime.now(UTC))
    assert "gpu_name" not in fields
    assert (fields["engine"], fields["device"], fields["models"]) == ("cpu", "cpu", "[]")


def test_publica_com_ttl_e_retira_no_desligamento(tmp_path: Path):
    redis = FakeRedis()
    registry = _registry(tmp_path)
    asyncio.run(publish(redis, WorkerConfig(), registry, FakeVram(GPU)))
    assert redis.hashes[HEALTH_KEY]["gpu_name"] == GPU["gpu_name"]
    assert redis.ttl[HEALTH_KEY] == HEALTH_TTL_SECONDS
    # A GPU que some (NVML falhou) não deixa campo velho para trás.
    asyncio.run(publish(redis, WorkerConfig(), registry, FakeVram(None)))
    assert "gpu_name" not in redis.hashes[HEALTH_KEY]
    asyncio.run(withdraw(redis))
    assert HEALTH_KEY not in redis.hashes


def test_loop_sobrevive_a_uma_falha(tmp_path: Path):
    redis = FakeRedis()
    registry = _registry(tmp_path)

    class Flaky:
        calls = 0

        def snapshot(self) -> dict[str, Any] | None:
            Flaky.calls += 1
            if Flaky.calls == 1:
                msg = "NVML_ERROR_UNKNOWN"
                raise RuntimeError(msg)
            return GPU

    async def go() -> None:
        task = asyncio.create_task(heartbeat_loop(redis, WorkerConfig(), registry, Flaky(), every=0.01))
        await asyncio.sleep(0.1)
        task.cancel()

    asyncio.run(go())
    assert Flaky.calls >= 2  # a primeira falhou e a segunda publicou
    assert HEALTH_KEY in redis.hashes
