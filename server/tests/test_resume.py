"""Agent chain resume (`resume_pipelines`): one loss window per test.

Each test deliberately loses the enqueueing of one step (Redis flickered between the commit and the
queue) and runs the sweep with the clock moved past `RESUME_AFTER`.
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
    """One pass with the clock at `now`, with no cap (the test session has many recordings)."""

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
    """Delete the steps (and the automatic summary) as if their enqueueing had never happened."""
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
    """Redis down between the ingestion commit and the chain enqueueing."""

    async def delete(self, *_keys: str) -> None:
        return None

    async def enqueue_job(self, *_args: object, **_kwargs: object) -> None:
        msg = "Redis fora do ar"
        raise ConnectionError(msg)


def test_agenda_type_that_never_reached_the_queue_comes_back(
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
    # Before `RESUME_AFTER`, nothing.
    assert f"{rid}: detect_agenda_type" not in _sweep(services, now)
    assert f"{rid}: detect_agenda_type" in _sweep(services, now + LATER)
    run_cpu(services.settings)
    steps = _steps(services, rid)
    assert {steps["agenda_type"], steps["fields"], steps["summary"]} <= {"done", "skipped", "failed"}


def test_fields_that_never_reached_the_queue_come_back(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    rid = _transcribed(api, services)
    _lose(services, rid, "fields", "summary")
    # This revision's `fill_fields` already ran in arq; the stored result would deduplicate the relaunch.
    run(_with_redis(services, lambda pool: pool.delete(f"{result_key_prefix}fill_fields:{rid}:1")))

    assert f"{rid}: fill_fields" in _sweep(services, datetime.now(UTC) + LATER)
    run_cpu(services.settings)
    steps = _steps(services, rid)
    assert steps["fields"] in {"done", "skipped", "failed"}
    assert "summary" in steps


def test_unopened_automatic_summary_is_opened_without_redoing_the_fields(
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
    """A transcribed recording on a platform with a provider: returns the session and the transcript."""
    admin.post("/api/v1/admin/agent-providers", json=CLAUDE)
    api = as_user(make_user())
    rid = _transcribed(api, services)
    return api, api.get(f"/api/v1/recordings/{rid}").json()["transcript_id"]


def _summary(api: Api, summary_id: str) -> dict[str, Any]:
    return api.get(f"/api/v1/summaries/{summary_id}").json()


def test_summary_missing_from_arq_is_requeued(summary_ready: tuple[Api, str], services: Services):
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


def test_summary_completed_in_arq_without_closing_becomes_a_failure(summary_ready: tuple[Api, str], services: Services):
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


def test_summary_arq_still_knows_is_not_touched(summary_ready: tuple[Api, str], services: Services):
    api, tid = summary_ready
    queued = api.post(f"/api/v1/transcripts/{tid}/summaries", json={}).json()
    swept = _sweep(services, datetime.now(UTC) + LATER)
    assert not [line for line in swept if line.startswith(queued["id"])]
    run_cpu(services.settings)
    assert _summary(api, queued["id"])["status"] == "done"
