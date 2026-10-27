"""GPU fair queue: one `transcribe` per account in `eclume:gpu`, dispatch on turn and 24 h minutes."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from arq import create_pool
from arq.connections import RedisSettings
from arq.constants import in_progress_key_prefix, job_key_prefix
from sqlalchemy import text

from eclume_server.db.session import make_engine
from eclume_server.dispatch import dispatch_waiting
from eclume_server.queue import GPU_QUEUE, transcribe_job_id
from eclume_server_testing.api import audio_bytes, override_quotas, upload_file
from eclume_server_testing.fakes import run_cpu, run_gpu
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services


async def _with_redis(services: Services, fn: Callable[[Any], Any]) -> Any:  # noqa: ANN401
    pool = await create_pool(RedisSettings.from_dsn(services.settings.redis_url))
    try:
        return await fn(pool)
    finally:
        await pool.aclose()


@pytest.fixture(autouse=True)
def _empty_gpu_queue(services: Services) -> Iterator[None]:
    """Start with `eclume:gpu` empty (the queue order is what the test checks) and end by draining it.

    Drain, not empty: a job dispatched and taken off the queue would stay open in the database
    forever and would show up in another test's Health.
    """

    async def empty(pool: Any) -> None:  # noqa: ANN401
        for job_id in await pool.zrange(GPU_QUEUE, 0, -1):
            await pool.delete(in_progress_key_prefix + job_id.decode(), job_key_prefix + job_id.decode())
        await pool.delete(GPU_QUEUE)

    run(_with_redis(services, empty))
    yield
    while _gpu_queue(services):
        run_gpu(services.settings)
        run_cpu(services.settings)


def _gpu_queue(services: Services) -> list[str]:
    async def read(pool: Any) -> list[str]:  # noqa: ANN401
        return [job_id.decode() for job_id in await pool.zrange(GPU_QUEUE, 0, -1)]

    return run(_with_redis(services, read))


def _job(recording: dict[str, Any]) -> str:
    return transcribe_job_id(recording["id"], 1)


def _dispatch_waiting(services: Services) -> list[Any]:
    async def go(pool: Any) -> list[Any]:  # noqa: ANN401
        engine = make_engine(services.settings.database_url)
        try:
            return await dispatch_waiting(engine, pool)
        finally:
            await engine.dispose()

    return run(_with_redis(services, go))


def _upload(api: Api, seed: str, **fields: Any) -> dict[str, Any]:  # noqa: ANN401
    return upload_file(api, audio_bytes(2000, seed=seed), **fields)


def test_one_transcribe_per_account_and_rotation_between_accounts(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    ana, bruno = as_user(make_user()), as_user(make_user())
    first, second, third = (_upload(ana, f"ana-{n}") for n in range(3))
    other = _upload(bruno, "bruno")
    # One person's ten files do not delay another's first: one from each account on the GPU.
    assert _gpu_queue(services) == [_job(first), _job(other)]
    assert ana.get(f"/api/v1/recordings/{second['id']}").json()["status"] == "queued"

    # Once the first finishes, ingestion dispatches the account's next one.
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert _gpu_queue(services) == [_job(second)]
    assert ana.get(f"/api/v1/recordings/{first['id']}").json()["status"] == "transcribed"

    # A `transcribe` failure also frees the turn.
    run_gpu(services.settings, fail=True)
    run_cpu(services.settings)
    assert _gpu_queue(services) == [_job(third)]
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert _gpu_queue(services) == []
    assert ana.get(f"/api/v1/recordings/{third['id']}").json()["status"] == "transcribed"


def test_over_the_minutes_the_recording_waits_for_the_window(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    override_quotas(services, api, {"gpu_minutes_24h": 2})
    first = _upload(api, "longa", duration_ms=150_000)
    waiting = _upload(api, "espera")
    run_gpu(services.settings)
    run_cpu(services.settings)
    # Three minutes dispatched in 24 h: the second waits in the database, without failing.
    assert api.get("/api/v1/me/usage").json()["usage"]["gpu_minutes_24h"] == 3
    assert _job(waiting) not in _gpu_queue(services)
    assert waiting["id"] not in [str(rid) for rid in _dispatch_waiting(services)]
    assert api.get(f"/api/v1/recordings/{waiting['id']}").json()["status"] == "queued"

    # The window opens (here, the first one's dispatch leaves the 24 h): the cron dispatches.
    async def age(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(
            text("UPDATE transcription_jobs SET dispatched_at = now() - interval '25 hours' WHERE recording_id = :r"),
            {"r": first["id"]},
        )

    run(services.sql(age))
    assert waiting["id"] in [str(rid) for rid in _dispatch_waiting(services)]
    assert _job(waiting) in _gpu_queue(services)


def test_retranscribe_and_retry_go_through_dispatch(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    first = _upload(api, "um")
    run_gpu(services.settings)
    run_cpu(services.settings)
    waiting = _upload(api, "dois")
    assert _gpu_queue(services) == [_job(waiting)]
    # Retranscribing with another account job on the GPU: it is held until its turn.
    assert api.post(f"/api/v1/recordings/{first['id']}/retranscribe").status_code == 202
    assert _gpu_queue(services) == [_job(waiting)]
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert _gpu_queue(services) == [transcribe_job_id(first["id"], 2)]
