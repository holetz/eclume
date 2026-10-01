"""Retomada da cadeia por agente (`resume_pipelines`): uma janela de perda por teste.

Cada teste perde, de propósito, o enfileiramento de uma etapa (o Redis oscilou entre o commit e a
fila) e roda a varredura com o relógio adiantado além de `RESUME_AFTER`.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import pytest
from arq import create_pool
from arq.connections import RedisSettings
from arq.constants import job_key_prefix, result_key_prefix
from arq.worker import func
from sqlalchemy import text

from eclume_server.db.session import make_engine
from eclume_server.queue import AGENT_QUEUE, summarize_job_id
from eclume_server.resume import resume
from eclume_server.storage import Storage
from eclume_server.worker import ingest_transcript
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import ENGINE_INFO, _drain, run_cpu, run_gpu
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

LATER = timedelta(minutes=10)
CLAUDE = {"name": "Claude (servidor)", "kind": "claude-cli", "model": "sonnet"}


async def _with_redis(services: Services, fn: Callable[[Any], Any]) -> Any:  # noqa: ANN401
    pool = await create_pool(RedisSettings.from_dsn(services.settings.redis_url))
    try:
        return await fn(pool)
    finally:
        await pool.aclose()


def _sweep(services: Services, now: datetime) -> list[str]:
    """Uma passada com o relógio em `now`, sem teto (a sessão de teste tem muitas gravações)."""

    async def go(pool: Any) -> list[str]:  # noqa: ANN401
        engine = make_engine(services.settings.database_url)
        try:
            return await resume(engine, pool, now=now, limit=100_000)
        finally:
            await engine.dispose()

    return run(_with_redis(services, go))


def _sql(services: Services, statement: str, **params: Any) -> Any:  # noqa: ANN401
    async def go(conn: Any) -> Any:  # noqa: ANN401
        result = await conn.execute(text(statement), params)
        return result.all() if result.returns_rows else None

    return run(services.sql(go))


def _steps(services: Services, recording_id: str) -> dict[str, str]:
    rows = _sql(
        services,
        "SELECT step, state FROM pipeline_steps WHERE recording_id = :r AND revision = 1",
        r=recording_id,
    )
    return dict(rows)


def _transcribed(api: Api, services: Services) -> str:
    recording = upload_file(api, audio_bytes(2300))
    run_gpu(services.settings)
    run_cpu(services.settings)
    return recording["id"]


def _lose(services: Services, recording_id: str, *steps: str) -> None:
    """Apaga as etapas (e o resumo automático) como se o enfileiramento delas nunca tivesse ocorrido."""
    _sql(
        services,
        "DELETE FROM pipeline_steps WHERE recording_id = :r AND step = ANY(:steps)",
        r=recording_id,
        steps=list(steps),
    )
    if "summary" in steps:
        _sql(
            services,
            "DELETE FROM summaries WHERE trigger = 'automatic' AND transcript_id IN "
            "(SELECT id FROM transcripts WHERE recording_id = :r)",
            r=recording_id,
        )


class _DroppingRedis:
    """O Redis caído entre o commit da ingestão e o enfileiramento da cadeia."""

    async def delete(self, *_keys: str) -> None:
        return None

    async def enqueue_job(self, *_args: object, **_kwargs: object) -> None:
        msg = "Redis fora do ar"
        raise ConnectionError(msg)


def test_tipo_de_agenda_que_nao_chegou_a_fila_volta(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(2310))
    rid = recording["id"]
    run_gpu(services.settings)

    async def ingest_without_queue() -> None:
        engine = make_engine(services.settings.database_url)
        ctx = {"engine": engine, "storage": Storage(services.settings), "redis": _DroppingRedis()}
        try:
            with pytest.raises(ConnectionError):
                await ingest_transcript(ctx, rid, f"recordings/{rid}/r1/transcript.raw.json", None, ENGINE_INFO)
        finally:
            await engine.dispose()

    run(ingest_without_queue())
    assert api.get(f"/api/v1/recordings/{rid}").json()["status"] == "transcribed"
    assert "agenda_type" not in _steps(services, rid)

    now = datetime.now(UTC)
    # Antes de `RESUME_AFTER`, nada.
    assert f"{rid}: detect_agenda_type" not in _sweep(services, now)
    assert f"{rid}: detect_agenda_type" in _sweep(services, now + LATER)
    run_cpu(services.settings)
    steps = _steps(services, rid)
    assert {steps["agenda_type"], steps["fields"], steps["summary"]} <= {"done", "skipped", "failed"}


def test_campos_que_nao_chegaram_a_fila_voltam(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    rid = _transcribed(api, services)
    _lose(services, rid, "fields", "summary")
    # O `fill_fields` desta revisão já rodou no arq; o resultado guardado deduplicaria o relançamento.
    run(_with_redis(services, lambda pool: pool.delete(f"{result_key_prefix}fill_fields:{rid}:1")))

    assert f"{rid}: fill_fields" in _sweep(services, datetime.now(UTC) + LATER)
    run_cpu(services.settings)
    steps = _steps(services, rid)
    assert steps["fields"] in {"done", "skipped", "failed"}
    assert "summary" in steps


def test_resumo_automatico_que_nao_foi_aberto_e_aberto_sem_refazer_os_campos(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    rid = _transcribed(api, services)
    _lose(services, rid, "summary")
    fields_before = _sql(
        services, "SELECT finished_at FROM pipeline_steps WHERE recording_id = :r AND step = 'fields'", r=rid
    )

    assert f"{rid}: summary" in _sweep(services, datetime.now(UTC) + LATER)
    assert "summary" in _steps(services, rid)
    run_cpu(services.settings)
    fields_after = _sql(
        services, "SELECT finished_at FROM pipeline_steps WHERE recording_id = :r AND step = 'fields'", r=rid
    )
    assert fields_after == fields_before


@pytest.fixture
def summary_ready(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
) -> tuple[Api, str]:
    """Uma gravação transcrita numa plataforma com provider: devolve a sessão e a transcrição."""
    admin.post("/api/v1/admin/agent-providers", json=CLAUDE)
    api = as_user(make_user())
    rid = _transcribed(api, services)
    return api, api.get(f"/api/v1/recordings/{rid}").json()["transcript_id"]


def _summary(api: Api, summary_id: str) -> dict[str, Any]:
    return api.get(f"/api/v1/summaries/{summary_id}").json()


def test_resumo_sumido_do_arq_e_reenfileirado(summary_ready: tuple[Api, str], services: Services):
    api, tid = summary_ready
    queued = api.post(f"/api/v1/transcripts/{tid}/summaries", json={}).json()
    job_id = summarize_job_id(queued["id"])

    async def lose(pool: Any) -> None:  # noqa: ANN401
        await pool.delete(job_key_prefix + job_id)
        await pool.zrem(AGENT_QUEUE, job_id)

    run(_with_redis(services, lose))
    assert f"{queued['id']}: summarize" in _sweep(services, datetime.now(UTC) + LATER)
    assert run(_with_redis(services, lambda pool: pool.zscore(AGENT_QUEUE, job_id))) is not None
    run_cpu(services.settings)
    assert _summary(api, queued["id"])["status"] == "done"


async def _done_without_closing(_ctx: dict[str, Any], *_args: Any) -> str:  # noqa: ANN401
    return "terminou sem gravar"


def test_resumo_concluido_no_arq_sem_fechar_vira_falha(summary_ready: tuple[Api, str], services: Services):
    api, tid = summary_ready
    queued = api.post(f"/api/v1/transcripts/{tid}/summaries", json={}).json()
    run(
        _drain(
            [func(_done_without_closing, name="summarize")],
            queue_name=AGENT_QUEUE,
            redis_settings=RedisSettings.from_dsn(services.settings.redis_url),
        )
    )
    assert f"{queued['id']}: failed" in _sweep(services, datetime.now(UTC) + LATER)
    summary = _summary(api, queued["id"])
    assert (summary["status"], summary["error"]["code"]) == ("failed", "internal_error")


def test_resumo_que_o_arq_ainda_conhece_nao_e_tocado(summary_ready: tuple[Api, str], services: Services):
    api, tid = summary_ready
    queued = api.post(f"/api/v1/transcripts/{tid}/summaries", json={}).json()
    swept = _sweep(services, datetime.now(UTC) + LATER)
    assert not [line for line in swept if line.startswith(queued["id"])]
    run_cpu(services.settings)
    assert _summary(api, queued["id"])["status"] == "done"
