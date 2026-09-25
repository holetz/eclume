"""Integração no host GPU contra o compose `eclume-gpu-test` (Redis, MinIO e o worker de pé).

Pulado sem `ECLUME_GPU_E2E=1`. No host:

    docker --context gpu-host compose -p eclume-gpu-test -f deploy/docker-compose.gpu-test.yml up -d --build --wait
    remote-run . 'ECLUME_GPU_E2E=1 uv run pytest worker-gpu/tests/test_gpu_e2e.py -v -s'
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

pytestmark = pytest.mark.skipif(os.environ.get("ECLUME_GPU_E2E") != "1", reason="exige o compose eclume-gpu-test")

ROOT = Path(__file__).parents[2]
FIXTURE = Path(__file__).parent / "fixtures" / "duas-vozes.ogg"
REDIS_URL = os.environ.get("ECLUME_GPU_E2E_REDIS_URL", "redis://127.0.0.1:16379/0")
S3_ENDPOINT = os.environ.get("ECLUME_GPU_E2E_S3_ENDPOINT", "http://127.0.0.1:19000")
BUCKET = "eclume"
# A primeira execução baixa os modelos para /srv/eclume/models.
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
        pytest.fail(f"nenhum job de retorno para {recording_id} em {TIMEOUT_S:.0f} s")
    finally:
        await pool.aclose()


def test_transcreve_o_dialogo_de_duas_vozes():
    recording_id = str(uuid.uuid4())
    audio_key = f"orgs/e2e/users/e2e/{recording_id}.ogg"
    client = s3()
    client.upload_file(str(FIXTURE), BUCKET, audio_key)

    options = {"language": "pt", "diarize": True, "embeddings": True, "min_speakers": 2, "max_speakers": 2}
    job, extra = asyncio.run(enqueue_and_wait(recording_id, audio_key, options))

    assert job.function == "ingest_transcript", job.args
    _, t_key, e_key, info = job.args
    print(json.dumps(info, ensure_ascii=False, indent=2))  # noqa: T201 — registro do benchmark curto
    assert t_key == f"recordings/{recording_id}/transcript.raw.json"
    assert e_key == f"recordings/{recording_id}/speaker_embeddings.json"
    assert info["engine"] == "whisperx-local"
    assert info["model"] == "large-v3-turbo"
    assert info["duration_ms"] > 25_000

    transcript = json.loads(client.get_object(Bucket=BUCKET, Key=t_key)["Body"].read())
    schema = json.loads((ROOT / "contracts" / "transcript.schema.json").read_text())
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(transcript)
    text = " ".join(s["text"] for s in transcript["segments"]).lower()
    for palavra in ("cronograma", "lideranças", "financeiro", "sexta"):
        assert palavra in text, text
    words = [w for s in transcript["segments"] for w in s.get("words", [])]
    assert words
    assert sum(w["start_ms"] is not None for w in words) / len(words) > 0.9

    embeddings = json.loads(client.get_object(Bucket=BUCKET, Key=e_key)["Body"].read())
    if "diarization_skipped_no_token" in info["warnings"]:
        assert [s["id"] for s in transcript["speakers"]] == ["S1"]
        assert embeddings["speaker_embeddings"] == {}
    else:
        assert len(transcript["speakers"]) == 2
        assert set(embeddings["speaker_embeddings"]) == {"S1", "S2"}

    assert extra["progress"]["stage"] == "upload"
    assert extra["progress"]["pct"] == "100"
    assert extra["progress"]["started_at"] == info["started_at"]
    assert 0 < extra["ttl"] <= 86_400


def test_audio_inexistente_gera_transcription_failed():
    recording_id = str(uuid.uuid4())
    job, _ = asyncio.run(enqueue_and_wait(recording_id, f"nao/existe/{recording_id}.ogg", {"language": "pt"}))
    assert job.function == "transcription_failed"
    assert job.args[:2] == (recording_id, "audio_download_failed")
