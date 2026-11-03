"""Why the recording waits: `Job.queue` with reason, position, estimate and processor."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import pytest
from arq import create_pool
from arq.connections import RedisSettings
from arq.constants import in_progress_key_prefix, job_key_prefix
from sqlalchemy import text

from eclume_server.queue import GPU_HEALTH_KEY, GPU_LAST_SEEN_KEY, GPU_QUEUE
from eclume_server.queue_status import PACE_KEY, _resumes_at
from eclume_server_testing.api import audio_bytes, override_quotas, upload_file
from eclume_server_testing.fakes import run_cpu, run_gpu
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

_KEYS = (GPU_HEALTH_KEY, GPU_LAST_SEEN_KEY, PACE_KEY)


async def _with_redis(services: Services, fn: Callable[[Any], Any]) -> Any:  # noqa: ANN401
    pool = await create_pool(RedisSettings.from_dsn(services.settings.redis_url))
    try:
        return await fn(pool)
    finally:
        await pool.aclose()


def _redis(services: Services, fn: Callable[[Any], Any]) -> Any:  # noqa: ANN401
    return run(_with_redis(services, fn))


@pytest.fixture(autouse=True)
def _clean(services: Services) -> Iterator[None]:
    """Start with `eclume:gpu` empty and no heartbeat; end by draining the queue."""

    async def empty(pool: Any) -> None:  # noqa: ANN401
        for job_id in await pool.zrange(GPU_QUEUE, 0, -1):
            await pool.delete(in_progress_key_prefix + job_id.decode(), job_key_prefix + job_id.decode())
        await pool.delete(GPU_QUEUE, *_KEYS)

    _redis(services, empty)
    yield
    _redis(services, lambda pool: pool.delete(*_KEYS))
    for _ in range(10):
        if not _redis(services, lambda pool: pool.zrange(GPU_QUEUE, 0, -1)):
            break
        run_gpu(services.settings)
        run_cpu(services.settings)


def _upload(api: Api, seed: str, **fields: Any) -> dict[str, Any]:  # noqa: ANN401
    return upload_file(api, audio_bytes(2000, seed=seed), **fields)


def _queue(api: Api, recording: dict[str, Any]) -> dict[str, Any] | None:
    return api.get(f"/api/v1/recordings/{recording['id']}").json()["job"]["queue"]


def test_reason_position_and_processor(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    ana, bruno = as_user(make_user()), as_user(make_user())
    first, second = _upload(ana, "ana-1", duration_ms=240_000), _upload(ana, "ana-2")
    other = _upload(bruno, "bruno", duration_ms=60_000)

    # No heartbeat and no last seen: offline, with no "since" and no estimate.
    offline = {"online": False, "offline_since": None}
    assert _queue(ana, first) == {
        "reason": "processor_queue",
        "ahead": 0,
        "account_ahead": None,
        "estimated_start_at": None,
        "resumes_at": None,
        "processor": offline,
    }
    assert _queue(bruno, other)["ahead"] == 1
    held = _queue(ana, second)
    assert (held["reason"], held["account_ahead"], held["ahead"]) == ("account_turn", 1, None)

    # Online and with a known pace: the estimated start adds up what comes before.
    _redis(services, lambda pool: pool.hset(GPU_HEALTH_KEY, mapping={"updated_at": "x", "busy": "0"}))
    _redis(services, lambda pool: pool.set(PACE_KEY, json.dumps([0.5, 120_000])))
    before = datetime.now(UTC)
    waiting = _queue(bruno, other)
    assert waiting["processor"] == {"online": True, "offline_since": None}
    estimated = datetime.fromisoformat(waiting["estimated_start_at"])
    # Ana's 4 min of audio, at half a minute of processing per minute: 2 min.
    assert before + timedelta(seconds=100) <= estimated <= before + timedelta(seconds=140)
    assert datetime.fromisoformat(_queue(ana, first)["estimated_start_at"]) <= before + timedelta(seconds=5)

    # Heartbeat expired: the "since" is the last seen, and the estimate disappears.
    _redis(services, lambda pool: pool.delete(GPU_HEALTH_KEY))
    _redis(services, lambda pool: pool.set(GPU_LAST_SEEN_KEY, "2026-10-01T14:02:00Z"))
    waiting = _queue(bruno, other)
    assert waiting["processor"] == {"online": False, "offline_since": "2026-10-01T14:02:00Z"}
    assert waiting["estimated_start_at"] is None

    # Outside `queued`, no `queue`.
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert _queue(ana, first) is None


def test_minutes_window_tells_when_it_frees_up(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    override_quotas(services, api, {"gpu_minutes_24h": 2})
    first = _upload(api, "longa", duration_ms=150_000)
    run_gpu(services.settings)
    run_cpu(services.settings)
    waiting = _upload(api, "espera")

    async def dispatched(conn: Any) -> datetime:  # noqa: ANN401
        return (
            await conn.execute(
                text("SELECT dispatched_at FROM transcription_jobs WHERE recording_id = :r"), {"r": first["id"]}
            )
        ).scalar_one()

    queue = _queue(api, waiting)
    assert queue["reason"] == "quota_window"
    assert datetime.fromisoformat(queue["resumes_at"]) == run(services.sql(dispatched)) + timedelta(hours=24)
    assert queue["account_ahead"] is None

    # Within the quota, there is no window to wait for.
    owner = api.get("/api/v1/me").json()["user"]["id"]
    assert run(services.sql(lambda conn: _resumes_at(conn, owner, 4))) is None
