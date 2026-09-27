"""Progresso em Redis, config por ambiente e acesso S3 com fakes."""

from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from eclume_worker.config import WorkerConfig
from eclume_worker.progress import PROGRESS_TTL_SECONDS, ProgressReporter, overall_pct, progress_key
from eclume_worker.storage import ArtifactStore, embeddings_key, sha256_file, transcript_key


class FakeRedis:
    def __init__(self) -> None:
        self.hashes: dict[str, dict] = {}
        self.ttl: dict[str, int] = {}
        self.writes = 0

    async def hset(self, key: str, mapping: dict) -> None:
        self.writes += 1
        self.hashes.setdefault(key, {}).update(mapping)

    async def expire(self, key: str, seconds: int) -> None:
        self.ttl[key] = seconds


def relogio() -> datetime:
    return datetime(2026, 9, 24, 12, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("stage", "pct", "esperado"),
    [
        ("download", 0, 0),
        ("preprocess", 0, 3),
        ("preprocess", 100, 10),
        ("asr", 0, 10),
        ("asr", 50, 32),
        ("align", 100, 70),
        ("upload", 100, 100),
        ("asr", 150, 55),
    ],
)
def test_pct_geral_por_etapa(stage: str, pct: float, esperado: int):
    assert overall_pct(stage, pct) == esperado


def test_reporter_grava_hash_com_ttl_e_nunca_recua():
    redis = FakeRedis()
    reporter = ProgressReporter(redis, "rec-1", clock=relogio)

    async def roda() -> None:
        await reporter.report("download")
        await reporter.report("asr", 50)
        await reporter.report("asr", 50)  # repetido: não grava
        await reporter.report("asr", 10)  # recuo: pct fica em 32
        await reporter.report("upload", 100)

    asyncio.run(roda())
    key = progress_key("rec-1")
    assert key == "eclume:progress:rec-1"
    assert redis.hashes[key] == {
        "stage": "upload",
        "pct": 100,
        "started_at": "2026-09-24T12:00:00Z",
        "updated_at": "2026-09-24T12:00:00Z",
    }
    assert redis.ttl[key] == PROGRESS_TTL_SECONDS
    assert redis.writes == 3


def test_config_do_ambiente():
    cfg = WorkerConfig.from_env(
        {
            "ECLUME_REDIS_URL": "redis://redis:6379/1",
            "ECLUME_S3_BUCKET": "gravacoes",
            "ECLUME_S3_ENDPOINT_URL": "http://minio:9000",
            "ECLUME_ENGINE": "cpu",
            "ECLUME_MODEL_IDLE_SECONDS": "60",
            "ECLUME_WORK_DIR": "/work",
        }
    )
    assert cfg.redis_url == "redis://redis:6379/1"
    assert cfg.s3_bucket == "gravacoes"
    assert cfg.s3_endpoint_url == "http://minio:9000"
    assert cfg.engine == "cpu"
    assert cfg.model_idle_seconds == 60.0
    assert cfg.work_dir == Path("/work")


def test_config_padrao():
    cfg = WorkerConfig.from_env({"ECLUME_ENGINE": ""})
    assert cfg.engine is None
    assert cfg.redis_url == "redis://localhost:6379/0"
    assert cfg.device == "cuda"


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {("b", "uploads/a.ogg"): b"OggS"}
        self.content_types: dict[str, str] = {}

    def download_file(self, bucket: str, key: str, filename: str) -> None:
        Path(filename).write_bytes(self.objects[bucket, key])

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, ContentType: str) -> None:  # noqa: N803 — API do boto3
        self.objects[Bucket, Key] = Body
        self.content_types[Key] = ContentType


def test_store_baixa_e_grava_json(tmp_path: Path):
    s3 = FakeS3()
    store = ArtifactStore(s3, "b")
    dest = tmp_path / "sub" / "a.ogg"
    store.download("uploads/a.ogg", dest)
    assert dest.read_bytes() == b"OggS"
    assert sha256_file(dest) == "sha256:" + hashlib.sha256(b"OggS").hexdigest()

    store.put_json(transcript_key("r1"), {"texto": "olá"})
    assert json.loads(s3.objects["b", "recordings/r1/transcript.raw.json"]) == {"texto": "olá"}
    assert s3.content_types["recordings/r1/transcript.raw.json"] == "application/json"
    assert embeddings_key("r1") == "recordings/r1/speaker_embeddings.json"
