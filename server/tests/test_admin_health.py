"""`/admin/health`: filas, heartbeat do worker GPU, jobs, etapas do pipeline, serviços e falhas."""

from __future__ import annotations

import json
import re
import uuid
from typing import TYPE_CHECKING, Any

import pytest
import redis
from sqlalchemy import text

from eclume_server.agents.base import ProviderError
from eclume_server.health import CPU_HEALTH_KEY, connected_assistants
from eclume_server.queue import GPU_HEALTH_KEY, GPU_QUEUE, progress_key, transcribe_job_id
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import FakeAgents, run_cpu, run_gpu
from eclume_server_testing.harness import run, while_recording_locked

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from fastapi.testclient import TestClient

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
    user = as_user(make_user())
    assert user.get(URL).status_code == 401
    assert user.pat("recordings:read").get(URL).status_code == 401


def test_heartbeat_fila_e_progresso(
    admin: Api,
    cache: redis.Redis,
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
):
    cache.hset(GPU_HEALTH_KEY, mapping=BEAT)
    alice, bob = as_user(make_user()), as_user(make_user())
    own = upload_file(alice, audio_bytes(1200), title="Reunião da Alice")
    private = upload_file(bob, audio_bytes(1300), title="Entrevista sigilosa")
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
    assert jobs[own["id"]]["updated_at"] == "2026-09-25T12:00:01Z"
    assert jobs[private["id"]]["state"] == "queued"
    assert jobs[private["id"]]["progress"] is None
    # O admin vê os jobs de todos, mas nunca o conteúdo: nenhum título de gravação.
    assert {job["recording_title"] for job in jobs.values()} == {"Gravação de usuário"}
    assert "Entrevista sigilosa" not in admin.get(URL).text

    cache.delete(f"arq:in-progress:{running_job}")
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert admin.get(URL).json()["running_jobs"] == []


def test_saude_ignora_progresso_de_outra_revisao(
    admin: Api,
    cache: redis.Redis,
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
):
    own = upload_file(as_user(make_user()), audio_bytes(1200))
    cache.hset(
        progress_key(own["id"]),
        mapping={"revision": "2", "stage": "diarize", "pct": "78", "updated_at": "2026-09-25T12:00:01Z"},
    )
    try:
        [job] = [j for j in admin.get(URL).json()["running_jobs"] if j["recording_id"] == own["id"]]
        assert (job["state"], job["stage"], job["progress"], job["updated_at"]) == ("queued", None, None, None)
    finally:
        cache.delete(progress_key(own["id"]))
        run_gpu(services.settings)
        run_cpu(services.settings)


def test_falhas_recentes_da_plataforma(
    admin: Api,
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
):
    recording = upload_file(as_user(make_user()), audio_bytes(1100), title="Vai falhar")
    run_gpu(services.settings, fail=True)
    run_cpu(services.settings)

    body: dict[str, Any] = admin.get(URL).json()
    assert body["queue"]["failed_last_24h"] == 1
    (failure,) = [f for f in body["recent_failures"] if f["recording_id"] == recording["id"]]
    assert failure["step"] == "transcription"
    assert failure["code"] == "gpu_oom"
    assert failure["message"] == "CUDA out of memory"
    assert failure["retryable"] is True
    assert failure["job_id"] is not None
    assert "Vai falhar" not in admin.get(URL).text


def test_admin_retenta_o_job_que_falhou_de_qualquer_usuario(
    admin: Api,
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
):
    member = as_user(make_user())
    recording = upload_file(member, audio_bytes(1200), title="Privada que falhou")
    run_gpu(services.settings, fail=True)
    run_cpu(services.settings)
    failed_job = member.get(f"/api/v1/recordings/{recording['id']}").json()["job"]
    retry = f"/api/v1/admin/jobs/{failed_job['id']}/retry"

    assert member.post(retry).status_code == 401
    assert member.pat("recordings:write").post(retry).status_code == 401
    assert admin.post(f"/api/v1/admin/jobs/{uuid.uuid4()}/retry").status_code == 404

    response = admin.post(retry)
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["recording_id"] == recording["id"]
    assert body["revision"] == 2
    assert body["state"] == "queued"
    after = member.get(f"/api/v1/recordings/{recording['id']}").json()
    assert after["status"] == "queued"
    assert after["job"]["id"] == body["job_id"]
    # O job antigo não é mais o mais recente, e o novo ainda não falhou.
    assert admin.post(retry).status_code == 409
    assert admin.post(f"/api/v1/admin/jobs/{body['job_id']}/retry").status_code == 409

    run_gpu(services.settings)
    run_cpu(services.settings)
    assert member.get(f"/api/v1/recordings/{recording['id']}").json()["status"] == "transcribed"


def test_etapas_das_ultimas_24h(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    before = {step["step"]: step for step in admin.get(URL).json()["steps"]}
    assert list(before) == ["preprocessing", "transcription", "fields", "agenda_type", "summary"]
    user = as_user(make_user())
    upload_file(user, audio_bytes(1400))
    run_gpu(services.settings)
    run_cpu(services.settings)
    after = {step["step"]: step for step in admin.get(URL).json()["steps"]}
    assert after["transcription"]["runs"] == before["transcription"]["runs"] + 1
    assert after["transcription"]["median_ms"] is not None
    # Sem provider, campos, tipo e resumo saem pulados: não contam como execução.
    assert after["fields"]["runs"] == before["fields"]["runs"]

    # Uma etapa por agente que falhou aparece sem job (não há o que o admin retente).
    admin.post("/api/v1/admin/agent-providers", json={"name": "Claude", "kind": "claude-cli", "model": "sonnet"})
    upload_file(user, audio_bytes(1500))
    run_gpu(services.settings)
    run_cpu(services.settings, FakeAgents(errors=[ProviderError("provider_auth", "Not logged in")]))
    body = admin.get(URL).json()
    # A cadeia começa pelo tipo de agenda: é a primeira etapa por agente a falhar.
    type_failure = next(f for f in body["recent_failures"] if f["step"] == "agenda_type")
    assert (type_failure["job_id"], type_failure["retryable"], type_failure["code"]) == (
        None,
        False,
        "provider_auth",
    )
    assert {s["step"]: s for s in body["steps"]}["agenda_type"]["failures"] >= 1


def test_servicos(admin: Api, cache: redis.Redis):
    cache.delete(GPU_HEALTH_KEY, CPU_HEALTH_KEY)
    services = {item["name"]: item for item in admin.get(URL).json()["services"]}
    assert list(services) == ["api", "postgres", "redis", "storage", "gpu_worker", "cpu_worker", "mcp"]
    assert {name: item["status"] for name, item in services.items()} == {
        "api": "healthy",
        "postgres": "healthy",
        "redis": "healthy",
        "storage": "healthy",
        "gpu_worker": "down",
        "cpu_worker": "down",
        "mcp": "healthy",
    }
    assert services["postgres"]["detail"] == "RLS ativa"
    assert all(item["latency_ms"] is not None for item in services.values())

    cache.hset(GPU_HEALTH_KEY, mapping=BEAT)
    cache.set(CPU_HEALTH_KEY, b"Oct-01 12:00:00 j_complete=1")
    services = {item["name"]: item for item in admin.get(URL).json()["services"]}
    assert (services["gpu_worker"]["status"], services["gpu_worker"]["detail"]) == ("healthy", "whisperx-local")
    assert services["cpu_worker"]["status"] == "healthy"
    cache.delete(CPU_HEALTH_KEY)


def test_servidor_mcp_conta_os_assistentes_das_ultimas_24h(
    admin: Api, client: TestClient, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    def connected() -> int:
        mcp = next(item for item in admin.get(URL).json()["services"] if item["name"] == "mcp")
        assert mcp["status"] == "healthy"
        match = re.match(r"(nenhum|\d+) assistentes? conectados? nas últimas 24 h", mcp["detail"])
        assert match is not None, mcp["detail"]
        return 0 if match.group(1) == "nenhum" else int(match.group(1))

    before = connected()
    session = as_user(make_user())
    token = session.pat("recordings:read").token
    session.pat("recordings:read").get("/api/v1/recordings")  # uso pela API não conta
    for _ in range(2):  # o mesmo assistente duas vezes conta uma
        client.cookies.clear()
        response = client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json, text/event-stream"},
        )
        assert response.status_code == 200
    assert connected() == before + 1
    assert connected_assistants(1) == "1 assistente conectado nas últimas 24 h"
    assert connected_assistants(2) == "2 assistentes conectados nas últimas 24 h"


def test_retentar_em_corrida_responde_409(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    member = as_user(make_user())
    recording = upload_file(member, audio_bytes(1250))
    run_gpu(services.settings, fail=True)
    run_cpu(services.settings)
    failed_job = member.get(f"/api/v1/recordings/{recording['id']}").json()["job"]
    # O primeiro pedido segura a gravação e cria a revisão 2; o segundo, à espera do lock, recebe 409.
    second = run(
        while_recording_locked(
            services,
            recording["id"],
            lambda: admin.post(f"/api/v1/admin/jobs/{failed_job['id']}/retry"),
            "INSERT INTO transcription_jobs (owner_id, recording_id, revision, state, options) "
            "SELECT owner_id, id, 2, 'queued', '{}' FROM recordings WHERE id = :id",
            id=recording["id"],
        )
    )
    assert second.status_code == 409, second.text
    assert second.headers["content-type"].startswith("application/problem+json")

    async def close(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(
            text("UPDATE transcription_jobs SET state = 'failed' WHERE recording_id = :id AND revision = 2"),
            {"id": recording["id"]},
        )

    run(services.sql(close))
