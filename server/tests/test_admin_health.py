"""`/admin/health`: filas, heartbeat do worker GPU, jobs em andamento e falhas da organização."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest
import redis

from eclume_server.queue import GPU_HEALTH_KEY, GPU_QUEUE, progress_key, transcribe_job_id
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import run_cpu, run_gpu

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator
    from uuid import UUID

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

URL = "/api/v1/admin/health"
BEAT = {
    "updated_at": "2026-09-25T12:00:00Z",
    "worker_version": "0.1.0",
    "engine": "whisperx-local",
    "device": "cuda",
    "busy": "1",
    "gpu_name": "NVIDIA GeForce GTX 1660 SUPER",
    "vram_total_mb": "6144",
    "vram_used_mb": "3120",
    "utilization_pct": "87.5",
    "models": json.dumps(
        [{"name": "large-v3-turbo", "kind": "asr", "loaded_at": "2026-09-25T11:59:10Z", "vram_mb": 2210}]
    ),
}


@pytest.fixture
def cache(services: Services) -> Iterator[redis.Redis]:
    client = redis.Redis.from_url(services.settings.redis_url)
    yield client
    client.delete(GPU_HEALTH_KEY)
    client.close()


@pytest.fixture
def admin_account(make_user: Callable[..., Account]) -> Account:
    return make_user(role="admin")


@pytest.fixture
def admin(as_user: Callable[[Account], Api], admin_account: Account) -> Api:
    return as_user(admin_account)


def test_sem_worker_e_sem_jobs(
    admin: Api, cache: redis.Redis, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    cache.delete(GPU_HEALTH_KEY)
    body = admin.get(URL).json()
    assert body["worker"] is None
    assert body["gpu"] is None
    assert body["models_loaded"] == []
    assert body["running_jobs"] == []
    assert body["queue"] == {"queued": 0, "running": 0, "failed_last_24h": 0}
    assert body["queues"] == [
        {"name": "eclume:gpu", "queued": 0, "running": 0},
        {"name": "eclume:default", "queued": 0, "running": 0},
    ]
    assert as_user(make_user()).get(URL).status_code == 403
    assert admin.pat("recordings:read").get(URL).status_code == 401


def test_heartbeat_fila_e_progresso(
    admin: Api,
    cache: redis.Redis,
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
):
    cache.hset(GPU_HEALTH_KEY, mapping=BEAT)
    member = as_user(make_user())
    own = upload_file(admin, audio_bytes(1200), title="Reunião do admin")
    private = upload_file(member, audio_bytes(1300), title="Entrevista sigilosa")
    # O primeiro job está rodando no worker: arq marca `in-progress` e o worker grava o progresso.
    running_job = transcribe_job_id(own["id"], 1)
    cache.set(f"arq:in-progress:{running_job}", b"1")
    cache.hset(
        progress_key(own["id"]),
        mapping={
            "stage": "diarize",
            "pct": "78",
            "started_at": "2026-09-25T11:59:00Z",
            "updated_at": "2026-09-25T12:00:01Z",
        },
    )

    body = admin.get(URL).json()
    assert body["worker"] == {
        "online": True,
        "last_seen_at": "2026-09-25T12:00:00Z",
        "version": "0.1.0",
        "engine": "whisperx-local",
        "device": "cuda",
        "busy": True,
    }
    assert body["gpu"] == {
        "name": "NVIDIA GeForce GTX 1660 SUPER",
        "vram_total_mb": 6144,
        "vram_used_mb": 3120,
        "utilization_pct": 87.5,
    }
    assert body["models_loaded"] == [
        {"name": "large-v3-turbo", "kind": "asr", "loaded_at": "2026-09-25T11:59:10Z", "vram_mb": 2210}
    ]
    assert body["queue"]["queued"] == 1
    assert body["queue"]["running"] == 1
    assert body["queues"][0] == {"name": GPU_QUEUE, "queued": 1, "running": 1}
    jobs = {job["recording_id"]: job for job in body["running_jobs"]}
    assert jobs[own["id"]]["state"] == "running"
    assert jobs[own["id"]]["stage"] == "diarization"
    assert jobs[own["id"]]["progress"] == pytest.approx(0.78)
    assert jobs[own["id"]]["recording_title"] == "Reunião do admin"
    assert jobs[own["id"]]["updated_at"] == "2026-09-25T12:00:01Z"
    # A gravação privada do membro aparece na saúde, mas sem o título.
    assert jobs[private["id"]]["state"] == "queued"
    assert jobs[private["id"]]["progress"] is None
    assert jobs[private["id"]]["recording_title"] == "Gravação privada"

    cache.delete(f"arq:in-progress:{running_job}")
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert admin.get(URL).json()["running_jobs"] == []


def test_falhas_recentes_so_da_organizacao(
    admin: Api,
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    make_org: Callable[[], UUID],
    services: Services,
):
    stranger = as_user(make_user(role="admin", org_id=make_org()))
    recording = upload_file(admin, audio_bytes(1100), title="Vai falhar")
    run_gpu(services.settings, fail=True)
    run_cpu(services.settings)

    body: dict[str, Any] = admin.get(URL).json()
    assert body["queue"]["failed_last_24h"] == 1
    (failure,) = body["recent_failures"]
    assert failure["recording_id"] == recording["id"]
    assert failure["code"] == "gpu_oom"
    assert failure["message"] == "CUDA out of memory"
    assert stranger.get(URL).json()["recent_failures"] == []
