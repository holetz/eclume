"""Integration on the GPU host against the `eclume-gpu-test` compose (Redis, MinIO and the worker up).

Skipped without `ECLUME_GPU_E2E=1`. In the host gate the `gpu-e2e` pillar (`deploy/gpu-e2e.sh`)
brings up the compose, sets the variable and runs these 2 tests without skips; by hand, on the host:

    docker --context gpu-host compose -p eclume-gpu-test -f deploy/docker-compose.gpu-test.yml up -d --build --wait
    remote-run . 'ECLUME_GPU_E2E=1 uv run pytest worker-gpu/tests/test_gpu_e2e.py -v -s'
    bash deploy/gate.sh --pilares gpu-e2e   # the gate's path, waiting for the GPU to be free
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator, FormatChecker

pytestmark = pytest.mark.skipif(os.environ.get("ECLUME_GPU_E2E") != "1", reason="requires the eclume-gpu-test compose")

ROOT = Path(__file__).parents[2]
FIXTURE = Path(__file__).parent / "fixtures" / "two-voices.ogg"
REDIS_URL = os.environ.get("ECLUME_GPU_E2E_REDIS_URL", "redis://127.0.0.1:16379/0")
S3_ENDPOINT = os.environ.get("ECLUME_GPU_E2E_S3_ENDPOINT", "http://127.0.0.1:19000")
BUCKET = "eclume"
# The first run downloads the models to /srv/eclume/models.
TIMEOUT_S = float(os.environ.get("ECLUME_GPU_E2E_TIMEOUT", "1800"))


def s3() -> Any:
    import boto3  # noqa: PLC0415

    return boto3.client(
        "s3",
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=os.environ.get("ECLUME_MINIO_USER", "eclume"),
        aws_secret_access_key=os.environ.get("ECLUME_MINIO_PASSWORD", "eclume-dev-secret"),
        region_name="us-east-1",
    )


async def enqueue_and_wait(recording_id: str, audio_key: str, options: dict) -> tuple[Any, dict]:
    from arq import create_pool  # noqa: PLC0415
    from arq.connections import RedisSettings  # noqa: PLC0415

    pool = await create_pool(RedisSettings.from_dsn(REDIS_URL))
    try:
        await pool.enqueue_job(
            "transcribe",
            recording_id,
            audio_key,
            options,
            _queue_name="eclume:gpu",
            _job_id=f"transcribe:{recording_id}:1",
        )
        deadline = time.monotonic() + TIMEOUT_S
        while time.monotonic() < deadline:
            for job in await pool.queued_jobs(queue_name="eclume:default"):
                if job.args and job.args[0] == recording_id:
                    progress = await pool.hgetall(f"eclume:progress:{recording_id}")
                    ttl = await pool.ttl(f"eclume:progress:{recording_id}")
                    return job, {"progress": {k.decode(): v.decode() for k, v in progress.items()}, "ttl": ttl}
            await asyncio.sleep(2)
        pytest.fail(f"no return job for {recording_id} within {TIMEOUT_S:.0f} s")
    finally:
        await pool.aclose()


def test_transcribes_the_two_voice_dialogue():
    recording_id = str(uuid.uuid4())
    audio_key = f"orgs/e2e/users/e2e/{recording_id}.ogg"
    client = s3()
    client.upload_file(str(FIXTURE), BUCKET, audio_key)

    options = {
        "language": "pt",
        "diarize": True,
        "embeddings": True,
        "min_speakers": 2,
        "max_speakers": 2,
        # The platform default: RNNoise, loudness and trimming the silence at the ends.
        "preprocess": {
            "denoise": {"enabled": True, "method": "rnnoise", "strength": 0.6},
            "loudnorm": {"enabled": True, "target_lufs": -16, "true_peak_db": -1.5, "lra": 11},
            "trim_silence": {"enabled": True, "min_silence_s": 3, "threshold_db": -50},
            "split_channels": {"enabled": False},
        },
    }
    job, extra = asyncio.run(enqueue_and_wait(recording_id, audio_key, options))

    assert job.function == "ingest_transcript", job.args
    _, t_key, e_key, info = job.args
    print(json.dumps(info, ensure_ascii=False, indent=2))  # noqa: T201 — short benchmark record
    assert job.job_id == f"ingest_transcript:{recording_id}:1"
    assert t_key == f"recordings/{recording_id}/r1/transcript.raw.json"
    assert e_key == f"recordings/{recording_id}/r1/speaker_embeddings.json"
    assert info["engine"] == "whisperx-local"
    assert info["model"] == "large-v3-turbo"
    assert info["duration_ms"] > 25_000
    pre = info["preprocess"]
    steps = {step["step"]: step for step in pre["steps"]}
    # The image ships the RNNoise model: the chain runs whole, with no fallback to format-only.
    assert (steps["denoise"]["state"], steps["denoise"]["params"]["method"]) == ("done", "rnnoise")
    assert steps["loudnorm"]["state"] == "done"
    assert pre["fallback"] is False
    assert "rnnoise_model_missing" not in info["warnings"]

    transcript = json.loads(client.get_object(Bucket=BUCKET, Key=t_key)["Body"].read())
    schema = json.loads((ROOT / "contracts" / "transcript.schema.json").read_text())
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(transcript)
    text = " ".join(s["text"] for s in transcript["segments"]).lower()
    for word in ("cronograma", "lideranças", "financeiro", "sexta"):
        assert word in text, text
    words = [w for s in transcript["segments"] for w in s.get("words", [])]
    assert words
    assert sum(w["start_ms"] is not None for w in words) / len(words) > 0.9
    # The time marks are the original audio's: no speech before the trimmed silence.
    assert all(s["start_ms"] >= pre["offset_ms"] for s in transcript["segments"])

    embeddings = json.loads(client.get_object(Bucket=BUCKET, Key=e_key)["Body"].read())
    if "diarization_skipped_no_token" in info["warnings"]:
        assert [s["id"] for s in transcript["speakers"]] == ["S1"]
        assert embeddings["speaker_embeddings"] == {}
    else:
        assert len(transcript["speakers"]) == 2
        assert set(embeddings["speaker_embeddings"]) == {"S1", "S2"}

    assert extra["progress"]["revision"] == "1"
    assert extra["progress"]["stage"] == "upload"
    assert extra["progress"]["pct"] == "100"
    assert extra["progress"]["started_at"] == info["started_at"]
    assert 0 < extra["ttl"] <= 86_400


def test_missing_audio_yields_transcription_failed():
    recording_id = str(uuid.uuid4())
    job, _ = asyncio.run(enqueue_and_wait(recording_id, f"does/not/exist/{recording_id}.ogg", {"language": "pt"}))
    assert job.function == "transcription_failed"
    assert job.args[:2] == (recording_id, "audio_download_failed")
    assert job.job_id == f"transcription_failed:{recording_id}:1"
