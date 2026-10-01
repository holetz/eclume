"""Job de transcrição morto: o cron `reap_stalled_jobs` e a falha recuperável.

Cada teste sobe uma gravação (o `transcribe` fica na fila `eclume:gpu`), monta no Redis o estado
de um cenário — job sumido, worker morto, worker vivo, progresso parado — e roda a varredura duas
vezes com o relógio adiantado: a primeira só registra a suspeita, a segunda confirma.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import pytest
from arq import create_pool
from arq.connections import RedisSettings
from arq.constants import in_progress_key_prefix, job_key_prefix
from arq.worker import func

from eclume_engines.fila import serializar
from eclume_server.db.session import make_engine
from eclume_server.queue import GPU_HEALTH_KEY, GPU_QUEUE, progress_key, transcribe_job_id
from eclume_server.stalled import reap
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import _drain
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

LATER = timedelta(minutes=10)
AFTER_GRACE = timedelta(minutes=13)


@pytest.fixture(autouse=True)
def _empty_gpu_queue(services: Services) -> Iterator[None]:
    """Esvazia a fila `eclume:gpu` depois do teste.

    Um job deixado "rodando" travaria o worker em modo burst de outro teste, que esperaria por ele.
    """
    yield

    async def empty(pool: Any) -> None:  # noqa: ANN401
        for job_id in await pool.zrange(GPU_QUEUE, 0, -1):
            await pool.delete(in_progress_key_prefix + job_id.decode(), job_key_prefix + job_id.decode())
        await pool.delete(GPU_QUEUE)

    run(_with_redis(services, empty))


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds").replace("+00:00", "Z")


async def _with_redis(services: Services, fn: Callable[[Any], Any]) -> Any:  # noqa: ANN401
    pool = await create_pool(RedisSettings.from_dsn(services.settings.redis_url))
    try:
        return await fn(pool)
    finally:
        await pool.aclose()


def _sweep(services: Services, now: datetime, recording_id: str) -> str | None:
    """Uma varredura com o relógio em `now`; o código marcado para esta gravação, ou `None`.

    A varredura vê os jobs de toda a sessão de teste; só a gravação do teste importa aqui.
    """

    async def go(pool: Any) -> list[str]:  # noqa: ANN401
        engine = make_engine(services.settings.database_url)
        try:
            return await reap(engine, pool, services.settings, now=now)
        finally:
            await engine.dispose()

    reaped = run(_with_redis(services, go))
    return next((line.split(": ", 1)[1] for line in reaped if line.startswith(f"{recording_id}: ")), None)


def _prepare(services: Services, recording_id: str, fn: Callable[[Any, str], Any]) -> None:
    job_id = transcribe_job_id(recording_id, 1)
    run(_with_redis(services, lambda pool: fn(pool, job_id)))


def _heartbeat(busy: bool, job_id: str | None = None) -> Callable[[Any], Any]:  # noqa: FBT001
    """Sem `job_id`, o heartbeat do worker antigo."""

    async def go(pool: Any) -> None:  # noqa: ANN401
        mapping = {"updated_at": _iso(datetime.now(UTC)), "busy": "1" if busy else "0"}
        await pool.delete(GPU_HEALTH_KEY)
        await pool.hset(GPU_HEALTH_KEY, mapping=mapping | ({"job_id": job_id} if job_id else {}))

    return go


def _clear_heartbeat(services: Services) -> None:
    run(_with_redis(services, lambda pool: pool.delete(GPU_HEALTH_KEY)))


def _recording(api: Api) -> dict[str, Any]:
    return upload_file(api, audio_bytes(2000))


def _state(api: Api, recording_id: str) -> dict[str, Any]:
    return api.get(f"/api/v1/recordings/{recording_id}").json()


def test_fila_atrasada_nunca_e_falha(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = _recording(api)
    now = datetime.now(UTC)
    assert _sweep(services, now + LATER, recording["id"]) is None
    assert _sweep(services, now + LATER + AFTER_GRACE, recording["id"]) is None
    assert _state(api, recording["id"])["status"] == "queued"


def test_job_sumido_da_fila_vira_job_lost_recuperavel_e_retranscreve(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = _recording(api)

    async def vanish(pool: Any, job_id: str) -> None:  # noqa: ANN401
        await pool.zrem(GPU_QUEUE, job_id)
        await pool.delete(job_key_prefix + job_id)

    _prepare(services, recording["id"], vanish)
    now = datetime.now(UTC)
    # A primeira varredura só registra a suspeita.
    assert _sweep(services, now + LATER, recording["id"]) is None
    assert _state(api, recording["id"])["status"] == "queued"
    # Nunca rodou: volta à fila uma vez, com o mesmo `_job_id` e o áudio da gravação.
    assert _sweep(services, now + LATER + AFTER_GRACE, recording["id"]) == "requeued"
    job_id = transcribe_job_id(recording["id"], 1)
    requeued = run(_with_redis(services, lambda pool: pool.zscore(GPU_QUEUE, job_id)))
    assert requeued is not None
    assert _state(api, recording["id"])["status"] == "queued"

    # Perdido de novo: com a marca, o veredito segue `job_lost`.
    _prepare(services, recording["id"], vanish)
    later = now + LATER + AFTER_GRACE
    assert _sweep(services, later + LATER, recording["id"]) is None
    assert _sweep(services, later + LATER + AFTER_GRACE, recording["id"]) == "job_lost"

    body = _state(api, recording["id"])
    assert body["status"] == "failed"
    assert body["job"]["error"]["code"] == "job_lost"
    assert body["job"]["error"]["retryable"] is True
    transcription = next(step for step in body["pipeline"] if step["step"] == "transcription")
    assert (transcription["state"], transcription["error"]["code"]) == ("failed", "job_lost")
    retried = api.post(f"/api/v1/recordings/{recording['id']}/retranscribe")
    assert retried.status_code == 202
    assert retried.json()["status"] == "queued"


def test_worker_morto_no_meio_vira_worker_lost(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = _recording(api)
    started = datetime.now(UTC)

    async def running(pool: Any, job_id: str) -> None:  # noqa: ANN401
        await pool.set(in_progress_key_prefix + job_id, b"1", ex=3600)
        await pool.hset(
            progress_key(recording["id"]), mapping={"stage": "asr", "pct": "40", "updated_at": _iso(started)}
        )

    _prepare(services, recording["id"], running)
    for busy in (None, False):  # heartbeat ausente, depois worker reiniciado e ocioso
        if busy is None:
            _clear_heartbeat(services)
        else:
            run(_with_redis(services, _heartbeat(busy)))
        assert _sweep(services, started + LATER, recording["id"]) is None
    assert _sweep(services, started + LATER + AFTER_GRACE, recording["id"]) == "worker_lost"
    _clear_heartbeat(services)
    body = _state(api, recording["id"])
    assert body["status"] == "failed"
    assert body["job"]["error"]["code"] == "worker_lost"
    assert body["job"]["state"] == "failed"


def test_worker_vivo_com_progresso_recente_nao_muda(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = _recording(api)
    now = datetime.now(UTC)

    async def running(pool: Any, job_id: str) -> None:  # noqa: ANN401
        await pool.set(in_progress_key_prefix + job_id, b"1", ex=3600)
        # O worker escreve o progresso "agora" em cada varredura simulada.
        await pool.hset(
            progress_key(recording["id"]), mapping={"stage": "diarize", "pct": "70", "updated_at": _iso(now + LATER)}
        )

    _prepare(services, recording["id"], running)
    run(_with_redis(services, _heartbeat(busy=True)))
    try:
        assert _sweep(services, now + LATER, recording["id"]) is None
        assert _sweep(services, now + LATER + timedelta(seconds=60), recording["id"]) is None
    finally:
        _clear_heartbeat(services)
    assert _state(api, recording["id"])["status"] == "processing"


def test_progresso_parado_alem_do_teto_vira_job_stalled(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = _recording(api)
    now = datetime.now(UTC)

    async def frozen(pool: Any, job_id: str) -> None:  # noqa: ANN401
        await pool.set(in_progress_key_prefix + job_id, b"1", ex=3600)
        await pool.hset(progress_key(recording["id"]), mapping={"stage": "asr", "pct": "10", "updated_at": _iso(now)})

    _prepare(services, recording["id"], frozen)
    run(_with_redis(services, _heartbeat(busy=True)))
    try:
        late = now + timedelta(seconds=services.settings.job_stall_seconds) + LATER
        assert _sweep(services, late, recording["id"]) is None
        assert _sweep(services, late + AFTER_GRACE, recording["id"]) == "job_stalled"
    finally:
        _clear_heartbeat(services)
    assert _state(api, recording["id"])["job"]["error"]["code"] == "job_stalled"


def _running_with_progress(recording_id: str, at: datetime, **fields: str) -> Callable[[Any, str], Any]:
    async def running(pool: Any, job_id: str) -> None:  # noqa: ANN401
        await pool.set(in_progress_key_prefix + job_id, b"1", ex=3600)
        await pool.hset(
            progress_key(recording_id), mapping={"stage": "asr", "pct": "40", "updated_at": _iso(at)} | fields
        )

    return running


def test_heartbeat_de_outro_job_vira_worker_lost(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = _recording(api)
    started = datetime.now(UTC)
    _prepare(services, recording["id"], _running_with_progress(recording["id"], started, revision="1"))
    # O worker está vivo e ocupado, mas com outro job: este ficou sem quem o termine.
    run(_with_redis(services, _heartbeat(busy=True, job_id=transcribe_job_id(recording["id"], 9))))
    try:
        assert _sweep(services, started + LATER, recording["id"]) is None
        assert _sweep(services, started + LATER + AFTER_GRACE, recording["id"]) == "worker_lost"
    finally:
        _clear_heartbeat(services)


def test_progresso_de_outra_revisao_nao_conta(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = _recording(api)
    now = datetime.now(UTC)
    # Progresso "recente" de outra revisão, sem worker neste job: vale como progresso ausente.
    _prepare(services, recording["id"], _running_with_progress(recording["id"], now + LATER, revision="7"))
    run(_with_redis(services, _heartbeat(busy=False)))
    try:
        assert _sweep(services, now + LATER, recording["id"]) is None
        assert _sweep(services, now + LATER + AFTER_GRACE, recording["id"]) == "worker_lost"
    finally:
        _clear_heartbeat(services)


def test_worker_pre_processando_nao_vira_worker_lost(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = _recording(api)
    started = datetime.now(UTC)
    # Pré-processamento longo: o progresso parou em `preprocess` além da graça (abaixo do teto), e o
    # heartbeat diz que o worker está neste job.
    _prepare(
        services, recording["id"], _running_with_progress(recording["id"], started, stage="preprocess", revision="1")
    )
    run(_with_redis(services, _heartbeat(busy=True, job_id=transcribe_job_id(recording["id"], 1))))
    try:
        assert _sweep(services, started + LATER, recording["id"]) is None
        assert _sweep(services, started + LATER + AFTER_GRACE, recording["id"]) is None
    finally:
        _clear_heartbeat(services)
    assert _state(api, recording["id"])["status"] == "processing"


async def _crash(_ctx: dict[str, Any], *_args: Any) -> None:  # noqa: ANN401
    msg = "worker morto"
    raise RuntimeError(msg)


# O resultado do arq em pickle (até a fase B da fila sem pickle) e em JSON: o reaper lê os dois.
SERIALIZERS = pytest.mark.parametrize("serializer", [None, serializar], ids=["pickle", "json"])


@SERIALIZERS
def test_job_encerrado_pelo_arq_sem_callback_vira_worker_lost(
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
    serializer: Callable[[dict], bytes] | None,
):
    api = as_user(make_user())
    recording = _recording(api)
    # O `transcribe` explode dentro do arq (como o retry de um worker morto): o resultado é falha e
    # ninguém enfileira `transcription_failed`.
    run(
        _drain(
            [func(_crash, name="transcribe")],
            queue_name=GPU_QUEUE,
            redis_settings=RedisSettings.from_dsn(services.settings.redis_url),
            max_jobs=1,
            **({"job_serializer": serializer} if serializer else {}),
        )
    )
    now = datetime.now(UTC)
    assert _sweep(services, now + LATER, recording["id"]) is None
    assert _sweep(services, now + LATER + AFTER_GRACE, recording["id"]) == "worker_lost"
    assert _state(api, recording["id"])["job"]["error"]["retryable"] is True


async def _done_without_ingest(_ctx: dict[str, Any], *_args: Any) -> str:  # noqa: ANN401
    return "ok"


@SERIALIZERS
def test_transcricao_pronta_sem_ingestao_alem_do_teto_vira_ingest_failed(
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
    serializer: Callable[[dict], bytes] | None,
):
    api = as_user(make_user())
    recording = _recording(api)
    # O `transcribe` termina com sucesso, mas a ingestão que ele enfileiraria nunca chega.
    run(
        _drain(
            [func(_done_without_ingest, name="transcribe")],
            queue_name=GPU_QUEUE,
            redis_settings=RedisSettings.from_dsn(services.settings.redis_url),
            max_jobs=1,
            **({"job_serializer": serializer} if serializer else {}),
        )
    )
    now = datetime.now(UTC)
    # Dentro do teto, a ingestão ainda pode estar na fila `eclume:default`.
    assert _sweep(services, now + LATER, recording["id"]) is None
    assert _sweep(services, now + LATER + AFTER_GRACE, recording["id"]) is None
    late = now + timedelta(seconds=services.settings.job_stall_seconds) + LATER
    assert _sweep(services, late, recording["id"]) is None
    assert _sweep(services, late + AFTER_GRACE, recording["id"]) == "ingest_failed"
    body = _state(api, recording["id"])
    assert body["status"] == "failed"
    assert body["job"]["error"]["code"] == "ingest_failed"
    assert body["job"]["error"]["retryable"] is True
