"""S3/MinIO access: download the audio and write the job's artifacts."""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path

    from eclume_worker.config import WorkerConfig

_CHUNK = 1024 * 1024


def transcript_key(recording_id: str, revision: int) -> str:
    """Bucket key of the revision's `transcript.raw.json`."""
    return f"recordings/{recording_id}/r{revision}/transcript.raw.json"


def embeddings_key(recording_id: str, revision: int) -> str:
    """Bucket key of the revision's `speaker_embeddings.json`."""
    return f"recordings/{recording_id}/r{revision}/speaker_embeddings.json"


def sha256_file(path: Path) -> str:
    """File hash in the contract format (`sha256:<hex>`)."""
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(_CHUNK):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


class ArtifactStore:
    """Synchronous boto3 operations; the worker calls them through `asyncio.to_thread`."""

    def __init__(self, client: Any, bucket: str) -> None:  # noqa: ANN401 — boto3 S3 client
        """`client` is an already configured `boto3.client("s3")`."""
        self.client = client
        self.bucket = bucket

    @classmethod
    def from_config(cls, config: WorkerConfig) -> ArtifactStore:
        """Create the boto3 S3 client (MinIO endpoint in dev and on the host)."""
        import boto3  # noqa: PLC0415 — importing boto3 costs ~0.5 s; only the worker uses it

        client = boto3.client(
            "s3",
            endpoint_url=config.s3_endpoint_url,
            aws_access_key_id=config.s3_access_key,
            aws_secret_access_key=config.s3_secret_key,
            region_name=config.s3_region,
        )
        return cls(client, config.s3_bucket)

    def download(self, key: str, dest: Path) -> None:
        """Download `key` to `dest`."""
        dest.parent.mkdir(parents=True, exist_ok=True)
        self.client.download_file(self.bucket, key, str(dest))

    def put_json(self, key: str, document: dict[str, Any]) -> None:
        """Write a UTF-8 JSON, overwriting (reprocessing the same revision overwrites)."""
        body = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode()
        self.client.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType="application/json")
