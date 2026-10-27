"""End to end with the fake GPU worker: upload → transcribe → ingest → read and export."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING
from uuid import UUID

import pytest
from botocore.exceptions import EndpointConnectionError
from sqlalchemy import text

from eclume_server.db.session import make_engine
from eclume_server.queue import Queue, progress_key
from eclume_server.storage import Storage
from eclume_server.transcripts import fail, render_markdown
from eclume_server.worker import INGEST_RETRY_DELAYS_S, ingest_transcript, transcription_failed
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import DEFAULT_VOICES, ENGINE_INFO, contract_transcript, run_cpu, run_gpu
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

LUMEA_SEGMENT_RE = re.compile(r"^\*\*(?P<speaker>[^*]+)\*\*\s+\[(?P<timestamp>[^\]]+)\]:\s*(?P<text>.*)$")


def _metadata() -> dict[str, object]:
    return {
        "title": "Alinhamento do programa de lideranças",
        "recorded_at": "2026-09-18T14:00:05Z",
        "language": "pt-BR",
        "source": "desktop",
        "tags": ["programa-liderancas"],
    }


def test_upload_transcribes_and_lumea_reads_by_pat(  # noqa: PLR0915 — the whole flow is the test
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user(name="Mariana Couto")
    session = as_user(account)
    desktop = session.pat("recordings:write", "recordings:read")
    lumea = session.pat("transcripts:read")

    recording = upload_file(desktop, audio_bytes(3000), **_metadata())
    calls = run_gpu(services.settings)
    assert [call[0] for call in calls] == [recording["id"]]

    # The GPU worker finished and published progress, but ingestion has not run yet.
    pending = desktop.get(f"/api/v1/recordings/{recording['id']}").json()
    assert pending["status"] == "processing"
    assert pending["job"]["stage"] == "finalizing"

    run_cpu(services.settings)
    done = desktop.get(f"/api/v1/recordings/{recording['id']}").json()
    assert done["status"] == "transcribed"
    assert done["job"]["state"] == "succeeded"
    assert done["job"]["progress"] == 1
    assert done["duration_ms"] == 166000
    transcript_id = done["transcript_id"]
    assert transcript_id

    listed = lumea.get("/api/v1/transcripts", params={"since": recording["created_at"]}).json()
    assert [item["id"] for item in listed["items"]] == [transcript_id]
    summary = listed["items"][0]
    assert summary["revision"] == 1
    assert summary["content_hash"] == recording["content_hash"]
    assert summary["owner"] == {"id": str(account.user_id), "name": "Mariana Couto"}
    assert [s["label"] for s in summary["speakers"]] == ["Locutor 1", "Locutor 2", "Locutor 3"]

    full = lumea.get(f"/api/v1/transcripts/{transcript_id}").json()
    source = contract_transcript()
    assert full["schema_version"] == "1.2"
    assert full["recording_id"] == recording["id"]
    assert full["title"] == "Alinhamento do programa de lideranças"
    assert full["recorded_at"] == "2026-09-18T14:00:05Z"
    assert full["source"] == "desktop"
    assert full["tags"] == ["programa-liderancas"]
    assert full["engine"]["model"] == "large-v3-turbo"
    assert [(s["id"], s["talk_ms"], s["person"]) for s in full["speakers"]] == [
        (s["id"], s["talk_ms"], None) for s in source["speakers"]
    ]
    assert [(s["id"], s["speaker_id"], s["start_ms"], s["text"]) for s in full["segments"]] == [
        (s["id"], s["speaker_id"], s["start_ms"], s["text"]) for s in source["segments"]
    ]
    assert all("words" not in s for s in full["segments"])
    with_words = lumea.get(f"/api/v1/transcripts/{transcript_id}", params={"include": "words"}).json()
    assert with_words["segments"][0]["words"] == source["segments"][0]["words"]

    exported = lumea.get(f"/api/v1/transcripts/{transcript_id}/export", params={"format": "md"})
    assert exported.status_code == 200
    assert exported.headers["content-type"].startswith("text/markdown")
    assert exported.headers["content-disposition"] == 'attachment; filename="alinhamento-do-programa-de-liderancas.md"'
    assert exported.text == render_markdown(full)
    body = [line for line in exported.text.split("---\n", 2)[2].splitlines() if line.strip()]
    assert len(body) == len(source["segments"])
    assert all(LUMEA_SEGMENT_RE.match(line) for line in body)
    assert lumea.get(f"/api/v1/transcripts/{transcript_id}/export", params={"format": "pdf"}).status_code == 422

    # Scopes: the lumea PAT does not read recordings; the desktop one does not read transcripts.
    assert lumea.get(f"/api/v1/recordings/{recording['id']}").json()["code"] == "insufficient_scope"
    assert desktop.get("/api/v1/transcripts").json()["required_scopes"] == ["transcripts:read"]

    # Inclusive `since`: repeating with the largest `updated_at` seen returns the item again.
    again = lumea.get("/api/v1/transcripts", params={"since": summary["updated_at"]}).json()
    assert [item["id"] for item in again["items"]] == [transcript_id]


def test_ingestion_is_idempotent_and_retranscription_bumps_revision(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3000))
    run_gpu(services.settings)
    run_cpu(services.settings)
    first = api.get(f"/api/v1/recordings/{recording['id']}").json()

    # A repeated `ingest_transcript` (redelivery) changes nothing.
    async def redeliver() -> None:
        queue = await Queue.connect(services.settings.redis_url)
        try:
            key = f"recordings/{recording['id']}/transcript.raw.json"
            await queue.pool.enqueue_job("ingest_transcript", recording["id"], key, None, ENGINE_INFO)
        finally:
            await queue.close()

    run(redeliver())
    run_cpu(services.settings)
    transcript = api.get(f"/api/v1/transcripts/{first['transcript_id']}").json()
    assert transcript["revision"] == 1

    assert api.post(f"/api/v1/recordings/{recording['id']}/retranscribe").status_code == 202
    calls = run_gpu(services.settings)
    assert len(calls) == 1
    run_cpu(services.settings)
    after = api.get(f"/api/v1/transcripts/{first['transcript_id']}").json()
    assert after["id"] == first["transcript_id"]
    assert after["revision"] == 2
    assert after["updated_at"] > transcript["updated_at"]
    assert api.get(f"/api/v1/recordings/{recording['id']}").json()["status"] == "transcribed"


class _EnqueueSpy:
    """The Redis of a directly called `ingest_transcript`: records what it would enqueue."""

    def __init__(self) -> None:
        self.jobs: list[str] = []

    async def delete(self, *keys: str) -> None:
        pass

    async def enqueue_job(self, name: str, *_args: object, **_kwargs: object) -> None:
        self.jobs.append(name)


def _ingest_directly(services: Services, recording_id: str) -> list[str]:
    """Runs `ingest_transcript` outside arq (without the `_job_id` deduplication); returns what was enqueued."""

    async def go() -> list[str]:
        engine = make_engine(services.settings.database_url)
        redis = _EnqueueSpy()
        ctx = {"engine": engine, "storage": Storage(services.settings), "redis": redis}
        try:
            key = f"recordings/{recording_id}/r1/transcript.raw.json"
            await ingest_transcript(ctx, recording_id, key, None, ENGINE_INFO)
        finally:
            await engine.dispose()
        return redis.jobs

    return run(go())


class _RedisSpy(_EnqueueSpy):
    """Also records the deleted keys."""

    def __init__(self, progress: dict[str, str] | None = None) -> None:
        super().__init__()
        self.deleted: list[str] = []
        self.progress = progress or {}

    async def delete(self, *keys: str) -> None:
        self.deleted.extend(keys)

    async def hget(self, _key: str, field: str) -> bytes | None:
        value = self.progress.get(field)
        return value.encode() if value is not None else None


def _deliver(
    services: Services, job: str, job_id: str | None, *args: object, progress: dict[str, str] | None = None
) -> _RedisSpy:
    """Runs a return job outside arq, with the given `_job_id` in `ctx` and the given progress hash."""

    async def go() -> _RedisSpy:
        engine = make_engine(services.settings.database_url)
        redis = _RedisSpy(progress)
        ctx = {"engine": engine, "storage": Storage(services.settings), "redis": redis, "job_id": job_id}
        try:
            function = ingest_transcript if job == "ingest_transcript" else transcription_failed
            await function(ctx, *args)
        finally:
            await engine.dispose()
        return redis

    return run(go())


def test_late_output_of_previous_revision_is_ignored(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3600))
    rid = recording["id"]
    run_gpu(services.settings)
    run_cpu(services.settings)
    first = api.get(f"/api/v1/recordings/{rid}").json()
    retried = api.post(f"/api/v1/recordings/{rid}/retranscribe")
    assert retried.status_code == 202

    # Revision 1 output arrives after revision 2 exists: it neither writes, fails nor deletes the progress.
    key = f"recordings/{rid}/r1/transcript.raw.json"
    spy = _deliver(services, "ingest_transcript", f"ingest_transcript:{rid}:1", rid, key, None, ENGINE_INFO)
    assert (spy.jobs, spy.deleted) == ([], [])
    spy = _deliver(services, "transcription_failed", f"transcription_failed:{rid}:1", rid, "gpu_oom", "OOM", "asr")
    assert spy.deleted == []
    body = api.get(f"/api/v1/recordings/{rid}").json()
    assert body["status"] == "queued"
    assert (body["job"]["state"], body["job"]["id"]) == ("queued", retried.json()["job"]["id"])
    assert api.get(f"/api/v1/transcripts/{first['transcript_id']}").json()["revision"] == 1

    # Revision 2 output closes its own job.
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert api.get(f"/api/v1/recordings/{rid}").json()["status"] == "transcribed"
    assert api.get(f"/api/v1/transcripts/{first['transcript_id']}").json()["revision"] == 2


def test_old_worker_without_revision_in_job_id_still_ingests(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3700))
    run_gpu(services.settings, legacy=True)
    run_cpu(services.settings)
    assert api.get(f"/api/v1/recordings/{recording['id']}").json()["status"] == "transcribed"

    failed = upload_file(api, audio_bytes(3800))
    run_gpu(services.settings, legacy=True, fail=True)
    run_cpu(services.settings)
    assert api.get(f"/api/v1/recordings/{failed['id']}").json()["job"]["error"]["code"] == "gpu_oom"


def test_retranscription_deletes_previous_revision_artifacts(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3900))
    rid = recording["id"]
    run_gpu(services.settings)
    run_cpu(services.settings)
    s3, bucket = services.s3(), services.settings.s3_bucket

    def listed() -> list[str]:
        return sorted(
            obj["Key"] for obj in s3.list_objects_v2(Bucket=bucket, Prefix=f"recordings/{rid}/").get("Contents", [])
        )

    assert listed() == [f"recordings/{rid}/r1/transcript.raw.json"]
    # An old key, without a revision, goes too.
    s3.put_object(Bucket=bucket, Key=f"recordings/{rid}/transcript.raw.json", Body=b"{}")

    assert api.post(f"/api/v1/recordings/{rid}/retranscribe").status_code == 202
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert listed() == [f"recordings/{rid}/r2/transcript.raw.json"]


def _flaky_read(monkeypatch: pytest.MonkeyPatch, failures: int) -> list[str]:
    """`Storage.read_json` with S3 down for the first `failures` calls; returns the calls."""
    original = Storage.read_json
    calls: list[str] = []

    async def read(storage: Storage, key: str) -> object:
        calls.append(key)
        if len(calls) <= failures:
            raise EndpointConnectionError(endpoint_url="http://minio:9000")
        return await original(storage, key)

    monkeypatch.setattr(Storage, "read_json", read)
    return calls


def test_ingestion_with_transient_failure_retries(
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
    monkeypatch: pytest.MonkeyPatch,
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(4000))
    run_gpu(services.settings)
    calls = _flaky_read(monkeypatch, failures=2)
    run_cpu(services.settings)
    assert len(calls) == 3
    assert api.get(f"/api/v1/recordings/{recording['id']}").json()["status"] == "transcribed"


def test_persistent_transient_failure_becomes_ingest_failed(
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
    monkeypatch: pytest.MonkeyPatch,
):
    # The waits fit under the reaper's ceiling, which does not declare `ingest_failed` mid-retries.
    assert sum(INGEST_RETRY_DELAYS_S) < services.settings.job_stall_seconds
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(4100))
    run_gpu(services.settings)
    calls = _flaky_read(monkeypatch, failures=99)
    run_cpu(services.settings)
    assert len(calls) == len(INGEST_RETRY_DELAYS_S) + 1
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert (body["status"], body["job"]["error"]["code"]) == ("failed", "ingest_failed")


def test_only_the_ingestion_that_writes_opens_the_agent_chain(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    # Repeated ingestion after the whole chain: nothing changes and nothing is enqueued.
    done = upload_file(api, audio_bytes(3100))
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert _ingest_directly(services, done["id"]) == []

    # Job already failed by the reaper when ingestion arrives: the transcript is not written and the chain does not start.
    reaped = upload_file(api, audio_bytes(3200))
    run_gpu(services.settings)
    run(services.sql(lambda conn: fail(conn, UUID(reaped["id"]), "job_lost", "sem worker")))
    assert _ingest_directly(services, reaped["id"]) == []
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{reaped['id']}").json()
    assert body["status"] == "failed"
    assert _states(body)["fields"] == "pending"

    # The ingestion that writes opens the chain with the agenda type.
    fresh = upload_file(api, audio_bytes(3300))
    run_gpu(services.settings)
    assert _ingest_directly(services, fresh["id"]) == ["detect_agenda_type"]
    run_cpu(services.settings)


def test_gpu_worker_failure_marks_job_and_recording(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3000))
    run_gpu(services.settings, fail=True)
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["status"] == "failed"
    assert body["job"]["state"] == "failed"
    assert body["job"]["error"] == {"code": "gpu_oom", "message": "CUDA out of memory", "retryable": True}
    assert body["job"]["finished_at"] is not None
    assert body["transcript_id"] is None
    steps = {step["step"]: step for step in body["pipeline"]}
    assert steps["received"]["state"] == "done"
    assert steps["transcription"]["state"] == "failed"
    assert steps["transcription"]["error"] == {"code": "gpu_oom", "message": "CUDA out of memory"}
    assert steps["summary"]["state"] == "pending"


@pytest.mark.usefixtures("platform")
def test_embeddings_only_with_voice_enabled_on_platform(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user()
    api = as_user(account)

    async def opt_in(conn):  # noqa: ANN001, ANN202
        await conn.execute(
            text(
                "UPDATE platform_settings"
                " SET voice_identification = jsonb_set(voice_identification, '{enabled}', 'true')"
            )
        )

    without = upload_file(api, audio_bytes(3000))
    run(services.sql(opt_in))
    with_opt_in = upload_file(api, audio_bytes(3000))
    # The `options` are fixed when the job is created; one `transcribe` per account on the GPU, so two rounds.
    calls = {call[0]: call[2] for call in run_gpu(services.settings)}
    run_cpu(services.settings)
    calls |= {call[0]: call[2] for call in run_gpu(services.settings)}
    assert calls[without["id"]]["embeddings"] is False
    assert calls[with_opt_in["id"]]["embeddings"] is True
    run_cpu(services.settings)

    async def count(conn):  # noqa: ANN001, ANN202
        rows = await conn.execute(
            text(
                "SELECT r.id::text, e.speaker_id, e.model, vector_dims(e.embedding) FROM speaker_embeddings e"
                " JOIN transcripts t ON t.id = e.transcript_id JOIN recordings r ON r.id = t.recording_id"
                " WHERE r.owner_id = :owner ORDER BY e.speaker_id"
            ),
            {"owner": account.user_id},
        )
        return [tuple(row) for row in rows]

    rows = run(services.sql(count))
    assert [(r[0], r[1], r[3]) for r in rows] == [(with_opt_in["id"], f"S{i}", 256) for i in (1, 2, 3)]


async def _voice_on(conn):  # noqa: ANN001, ANN202
    await conn.execute(
        text("UPDATE platform_settings SET voice_identification = jsonb_set(voice_identification, '{enabled}', 'true')")
    )


def _embedded_speakers(services: Services, recording_id: str) -> list[str]:
    async def go(conn):  # noqa: ANN001, ANN202
        rows = await conn.execute(
            text(
                "SELECT e.speaker_id FROM speaker_embeddings e JOIN transcripts t ON t.id = e.transcript_id"
                " WHERE t.recording_id = :recording ORDER BY e.speaker_id"
            ),
            {"recording": UUID(recording_id)},
        )
        return [row[0] for row in rows]

    return run(services.sql(go))


@pytest.mark.usefixtures("platform")
def test_non_finite_embedding_from_old_worker_does_not_break_ingestion(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    # Speech too short: pyannote yields NaN, and an old worker writes it to `speaker_embeddings.json`.
    api = as_user(make_user())
    run(services.sql(_voice_on))
    recording = upload_file(api, audio_bytes(3400))
    voices = dict(DEFAULT_VOICES) | {"S2": [float("nan")] * 256}
    run_gpu(services.settings, voices=voices)
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["status"] == "transcribed"
    assert _embedded_speakers(services, recording["id"]) == ["S1", "S3"]


@pytest.mark.usefixtures("platform")
def test_failing_ingestion_becomes_retryable_failure(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    # Any ingestion error rolls the transaction back; the recording must not stay stuck in the queue.
    api = as_user(make_user())
    run(services.sql(_voice_on))
    recording = upload_file(api, audio_bytes(3500))
    run_gpu(services.settings, voices=dict(DEFAULT_VOICES) | {"S2": ["não é número"]})
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["status"] == "failed"
    assert body["transcript_id"] is None
    assert body["job"]["state"] == "failed"
    assert body["job"]["error"]["code"] == "ingest_failed"
    assert body["job"]["error"]["retryable"] is True
    transcription = next(step for step in body["pipeline"] if step["step"] == "transcription")
    assert (transcription["state"], transcription["error"]["code"]) == ("failed", "ingest_failed")

    # Retranscribing with a worker that writes valid embeddings fixes it.
    assert api.post(f"/api/v1/recordings/{recording['id']}/retranscribe").status_code == 202
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert api.get(f"/api/v1/recordings/{recording['id']}").json()["status"] == "transcribed"


def _states(body: dict) -> dict[str, str]:
    return {step["step"]: step["state"] for step in body["pipeline"]}


def test_pipeline_steps_per_revision(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3100))
    assert [step["step"] for step in recording["pipeline"]] == [
        "received",
        "preprocessing",
        "transcription",
        "speakers",
        "agenda_type",
        "fields",
        "summary",
    ]
    assert _states(recording) == {
        "received": "done",
        "preprocessing": "pending",
        "transcription": "pending",
        "speakers": "pending",
        "fields": "pending",
        "agenda_type": "pending",
        "summary": "pending",
    }

    # With the GPU worker reporting progress, transcription shows as active.
    async def progress() -> None:
        queue = await Queue.connect(services.settings.redis_url)
        try:
            await queue.pool.hset(progress_key(recording["id"]), mapping={"stage": "asr", "pct": "40"})
        finally:
            await queue.close()

    run(progress())
    running = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert _states(running)["transcription"] == "active"

    run_gpu(services.settings)
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    transcription = next(step for step in body["pipeline"] if step["step"] == "transcription")
    assert transcription["state"] == "done"
    assert transcription["finished_at"] is not None
    assert transcription["duration_ms"] >= 0

    # Retranscription opens a new revision: the chain restarts.
    retried = api.post(f"/api/v1/recordings/{recording['id']}/retranscribe").json()
    assert (_states(retried)["received"], _states(retried)["transcription"]) == ("done", "pending")
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert _states(api.get(f"/api/v1/recordings/{recording['id']}").json())["transcription"] == "done"


def _step(body: dict, name: str) -> dict:
    return next(step for step in body["pipeline"] if step["step"] == name)


def test_preprocessing_goes_into_options_and_becomes_a_step(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3200))
    ((_, _, options),) = run_gpu(services.settings)
    assert options["preprocess"] == {
        "denoise": {"enabled": True, "method": "rnnoise", "strength": 0.6},
        "loudnorm": {"enabled": True, "target_lufs": -16, "true_peak_db": -1.5, "lra": 11},
        "trim_silence": {"enabled": True, "min_silence_s": 3, "threshold_db": -50},
        "split_channels": {"enabled": False},
    }
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    pre, transcription = _step(body, "preprocessing"), _step(body, "transcription")
    assert (pre["state"], pre["duration_ms"]) == ("done", 1500)
    assert pre["finished_at"] == transcription["started_at"]

    # The chain fell back to format only: the step fails and transcription goes on.
    api.post(f"/api/v1/recordings/{recording['id']}/retranscribe")
    run_gpu(services.settings, preprocess_fallback=True)
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert _step(body, "preprocessing")["error"] == {"code": "preprocess_failed", "message": "arnndn: modelo inválido"}
    assert _step(body, "transcription")["state"] == "done"


def test_preprocessing_failure_marks_the_right_step(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3300))

    async def progress() -> None:
        queue = await Queue.connect(services.settings.redis_url)
        try:
            await queue.pool.hset(progress_key(recording["id"]), mapping={"stage": "preprocess", "pct": "5"})
        finally:
            await queue.close()

    run(progress())
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["job"]["stage"] == "preprocessing"
    assert _step(body, "preprocessing")["state"] == "active"

    run_gpu(services.settings, fail=True, fail_stage="preprocess", failure=("audio_decode_failed", "não abre"))
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert _step(body, "preprocessing")["error"] == {"code": "audio_decode_failed", "message": "não abre"}
    assert _step(body, "transcription")["state"] == "pending"


def test_job_started_at_is_gpu_worker_start_on_success(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3400))
    run_gpu(services.settings)
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    # The job start is the worker's (`engine_info.started_at`), the same as preprocessing's.
    assert body["job"]["started_at"] == _step(body, "preprocessing")["started_at"]


def test_job_started_at_is_gpu_worker_start_on_failure(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3500))
    rid = recording["id"]
    started = (datetime.now(UTC) - timedelta(seconds=3)).isoformat()
    _deliver(
        services,
        "transcription_failed",
        f"transcription_failed:{rid}:1",
        rid,
        "gpu_oom",
        "OOM",
        "asr",
        progress={"started_at": started},
    )
    body = api.get(f"/api/v1/recordings/{rid}").json()
    assert datetime.fromisoformat(body["job"]["started_at"]) == datetime.fromisoformat(started)
    assert datetime.fromisoformat(_step(body, "transcription")["started_at"]) == datetime.fromisoformat(started)
