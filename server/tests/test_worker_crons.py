"""Crons do worker: o registro de `WorkerSettings` e as três tarefas que não tinham teste.

O registro é uma tabela literal, de propósito: tirar um cron ou mudar a agenda obriga a rever o teste.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Any
from uuid import uuid4

import pytest
from arq import create_pool
from arq.connections import RedisSettings
from sqlalchemy import text

from eclume_server import storage_deletions
from eclume_server.config import Settings
from eclume_server.db.session import make_engine
from eclume_server.queue import GPU_QUEUE, transcribe_job_id
from eclume_server.storage import Storage
from eclume_server.worker import (
    dispatch_transcriptions,
    drain_storage_deletions,
    expire_pairing_codes,
    expire_uploads,
    purge_audio,
    purge_expired,
    reap_stalled_jobs,
    reconcile_storage,
    resume_pipelines,
    worker_settings,
)
from eclume_server_testing.api import audio_bytes, override_quotas, upload_file
from eclume_server_testing.fakes import run_cpu, run_gpu
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

# (função, minuto, hora, dia da semana, segundo): o que o arq guarda em cada campo da agenda.
CRONS = [
    (expire_uploads, {0, 30}, None, None, 0),
    (expire_pairing_codes, 15, None, None, 0),
    (purge_expired, 40, 3, None, 0),
    (purge_audio, 50, 3, None, 0),
    (reap_stalled_jobs, None, None, None, 0),
    (dispatch_transcriptions, None, None, None, 15),
    (resume_pipelines, set(range(2, 60, 5)), None, None, 0),
    (drain_storage_deletions, None, None, None, 30),
    (reconcile_storage, 0, 4, "sun", 0),
]


def test_registro_dos_nove_crons_com_agenda_unique_e_sem_run_at_startup():
    registrados = worker_settings(Settings())["cron_jobs"]
    assert [job.coroutine for job in registrados] == [c[0] for c in CRONS]
    for job, (func, minute, hour, weekday, second) in zip(registrados, CRONS, strict=True):
        assert job.name == f"cron:{func.__name__}"
        assert (job.minute, job.hour, job.weekday, job.second) == (minute, hour, weekday, second), job.name
        assert (job.month, job.day, job.microsecond) == (None, None, 123456), job.name
        assert job.run_at_startup is False, job.name
        assert job.unique is True, job.name


def _cron(services: Services, func: Callable[[dict[str, Any]], Any]) -> Any:  # noqa: ANN401
    """Roda a função do cron como o arq a chama: com o `ctx` do worker (engine, Redis, bucket)."""

    async def go() -> Any:  # noqa: ANN401
        engine = make_engine(services.settings.database_url)
        pool = await create_pool(RedisSettings.from_dsn(services.settings.redis_url))
        try:
            return await func({"engine": engine, "redis": pool, "storage": Storage(services.settings)})
        finally:
            await pool.aclose()
            await engine.dispose()

    return run(go())


def _sql(services: Services, statement: str, **params: Any) -> Any:  # noqa: ANN401
    async def go(conn: Any) -> Any:  # noqa: ANN401
        result = await conn.execute(text(statement), params)
        return result.all() if result.returns_rows else None

    return run(services.sql(go))


def _pairing_ids(services: Services, *ids: str) -> set[str]:
    rows = _sql(services, "SELECT id FROM pairing_codes WHERE id = ANY(CAST(:ids AS uuid[]))", ids=list(ids))
    return {str(row[0]) for row in rows}


def test_pareamento_apaga_so_o_vencido_ha_mais_de_um_dia_sem_uso(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    session = as_user(make_user())
    old, recent, used = (session.post("/api/v1/devices/pairing-codes").json()["id"] for _ in range(3))
    _sql(services, "UPDATE pairing_codes SET expires_at = now() - interval '2 days' WHERE id = :id", id=old)
    # Borda: vencido há pouco fica (a janela de um dia), e o usado fica mesmo velho (guarda o `token_id`).
    _sql(services, "UPDATE pairing_codes SET expires_at = now() - interval '1 hour' WHERE id = :id", id=recent)
    _sql(
        services,
        "UPDATE pairing_codes SET expires_at = now() - interval '2 days', used_at = now() - interval '2 days'"
        " WHERE id = :id",
        id=used,
    )
    assert _cron(services, expire_pairing_codes) >= 1
    assert _pairing_ids(services, old, recent, used) == {recent, used}
    assert _cron(services, expire_pairing_codes) == 0


def _gpu_queue(services: Services) -> list[str]:
    async def read() -> list[str]:
        pool = await create_pool(RedisSettings.from_dsn(services.settings.redis_url))
        try:
            return [job_id.decode() for job_id in await pool.zrange(GPU_QUEUE, 0, -1)]
        finally:
            await pool.aclose()

    return run(read())


@pytest.fixture
def _drain_gpu(services: Services) -> Iterator[None]:
    """Termina drenando `eclume:gpu`: um job despachado e esquecido ficaria em aberto para os outros testes."""
    yield
    while _gpu_queue(services):
        run_gpu(services.settings)
        run_cpu(services.settings)


@pytest.mark.usefixtures("_drain_gpu")
def test_despacho_poe_na_gpu_o_job_retido_so_quando_a_janela_abre(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    override_quotas(services, api, {"gpu_minutes_24h": 2})
    first = upload_file(api, audio_bytes(2000, seed="crons-longa"), duration_ms=150_000)
    waiting = upload_file(api, audio_bytes(2000, seed="crons-espera"))
    run_gpu(services.settings)
    run_cpu(services.settings)
    job = transcribe_job_id(waiting["id"], 1)
    # Borda: com os minutos de 24 h estourados a conta fica retida, e o cron não despacha nada dela.
    # (o retorno do cron conta o banco inteiro, então a prova é a fila e o estado da gravação.)
    _cron(services, dispatch_transcriptions)
    assert job not in _gpu_queue(services)
    assert api.get(f"/api/v1/recordings/{waiting['id']}").json()["status"] == "queued"

    # A janela abre (o despacho do primeiro sai das 24 h): o cron despacha o retido, uma vez.
    _sql(
        services,
        "UPDATE transcription_jobs SET dispatched_at = now() - interval '25 hours' WHERE recording_id = :r",
        r=first["id"],
    )
    assert _cron(services, dispatch_transcriptions) >= 1
    assert _gpu_queue(services).count(job) == 1
    # Uma segunda passada não repete o despacho.
    _cron(services, dispatch_transcriptions)
    assert _gpu_queue(services).count(job) == 1


def test_reconcilia_enfileira_o_orfao_velho_e_poupa_o_recente_e_o_conhecido(
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
    monkeypatch: pytest.MonkeyPatch,
):
    api = as_user(make_user())
    kept = upload_file(api, audio_bytes(2000, seed="crons-conhecida"))
    kept_key = _sql(services, "SELECT audio_key FROM recordings WHERE id = :r", r=kept["id"])[0][0]
    s3, bucket = services.s3(), services.settings.s3_bucket
    tag = uuid4()
    orphan = f"users/{tag}/recordings/{tag}/audio"
    s3.put_object(Bucket=bucket, Key=orphan, Body=b"x")

    def queued() -> set[tuple[str | None, str | None]]:
        rows = _sql(services, "SELECT key, prefix FROM storage_deletions")
        return {(key, prefix) for key, prefix in rows}

    before = {row[0] for row in _sql(services, "SELECT id FROM storage_deletions")}
    try:
        # Borda: o objeto recém-criado está dentro da margem de 24 h e fica fora da fila.
        _cron(services, reconcile_storage)
        assert not any(orphan in pair for pair in queued())

        # Com a margem zerada o órfão entra na fila; o áudio de uma gravação do banco nunca entra.
        monkeypatch.setattr(storage_deletions, "ORPHAN_AGE", -timedelta(hours=1))
        assert _cron(services, reconcile_storage) >= 1
        assert (orphan, None) in queued()
        assert not any(kept_key in pair or f"recordings/{kept['id']}/" in pair for pair in queued())
        # Uma segunda passada não duplica o que já está na fila.
        assert _cron(services, reconcile_storage) == 0
    finally:
        # Desfaz tudo o que esta passada enfileirou, inclusive os órfãos de outros testes.
        _sql(services, "DELETE FROM storage_deletions WHERE id <> ALL(CAST(:ids AS uuid[]))", ids=list(before))
        s3.delete_object(Bucket=bucket, Key=orphan)
