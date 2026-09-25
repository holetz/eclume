"""Acesso ao S3/MinIO: baixa o áudio e grava os artefatos do job."""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path

    from eclume_worker.config import WorkerConfig

_CHUNK = 1024 * 1024


def transcript_key(recording_id: str) -> str:
    """Chave do `transcript.raw.json` no bucket."""
    return f"recordings/{recording_id}/transcript.raw.json"


def embeddings_key(recording_id: str) -> str:
    """Chave do `speaker_embeddings.json` no bucket."""
    return f"recordings/{recording_id}/speaker_embeddings.json"


def sha256_file(path: Path) -> str:
    """Hash do arquivo no formato do contrato (`sha256:<hex>`)."""
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(_CHUNK):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


class ArtifactStore:
    """Operações síncronas do boto3; o worker as chama por `asyncio.to_thread`."""

    def __init__(self, client: Any, bucket: str) -> None:  # noqa: ANN401 — cliente S3 do boto3
        """`client` é um `boto3.client("s3")` já configurado."""
        self.client = client
        self.bucket = bucket

    @classmethod
    def from_config(cls, config: WorkerConfig) -> ArtifactStore:
        """Cria o cliente S3 do boto3 (endpoint do MinIO em dev e no host)."""
        import boto3  # noqa: PLC0415 — o import do boto3 custa ~0,5 s; só o worker o usa

        client = boto3.client(
            "s3",
            endpoint_url=config.s3_endpoint_url,
            aws_access_key_id=config.s3_access_key,
            aws_secret_access_key=config.s3_secret_key,
            region_name=config.s3_region,
        )
        return cls(client, config.s3_bucket)

    def download(self, key: str, dest: Path) -> None:
        """Baixa `key` para `dest`."""
        dest.parent.mkdir(parents=True, exist_ok=True)
        self.client.download_file(self.bucket, key, str(dest))

    def put_json(self, key: str, document: dict[str, Any]) -> None:
        """Grava um JSON UTF-8, sobrescrevendo (reprocessar a mesma revisão sobrescreve)."""
        body = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode()
        self.client.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType="application/json")
