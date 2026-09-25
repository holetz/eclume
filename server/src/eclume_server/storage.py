"""Armazenamento de objetos (S3/MinIO): multipart do upload, hash e leitura do áudio.

O boto3 é síncrono; as corrotinas daqui rodam as chamadas numa thread.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from starlette.concurrency import run_in_threadpool

if TYPE_CHECKING:
    from collections.abc import Iterator
    from uuid import UUID

    from eclume_server.config import Settings

_CHUNK = 1024 * 1024
# Limite de chaves por `DeleteObjects` do S3.
_DELETE_BATCH = 1000


def audio_key(org_id: UUID, owner_id: UUID, recording_id: UUID) -> str:
    """Chave do áudio: a gravação vive sob o dono (`orgs/{org}/users/{id}/...`)."""
    return f"orgs/{org_id}/users/{owner_id}/recordings/{recording_id}/audio"


def embeddings_object_key(recording_id: UUID | str) -> str:
    """`speaker_embeddings.json` do worker GPU (contrato de jobs)."""
    return f"{artifacts_prefix(recording_id)}speaker_embeddings.json"


def artifacts_prefix(recording_id: UUID | str) -> str:
    """Prefixo dos artefatos do worker GPU (contrato de jobs)."""
    return f"recordings/{recording_id}/"


@dataclass(frozen=True)
class StoredPart:
    """Parte que o armazenamento já confirmou."""

    part_number: int
    etag: str
    size_bytes: int


@dataclass(frozen=True)
class ObjectRange:
    """Corpo (ou trecho) de um objeto, para servir com `Range`."""

    chunks: Iterator[bytes]
    content_length: int
    content_range: str | None
    content_type: str


class Storage:
    """Cliente do bucket do eclume."""

    def __init__(self, settings: Settings) -> None:
        """Cliente boto3 apontado para o endpoint S3 da configuração."""
        self.bucket = settings.s3_bucket
        self._s3 = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            region_name=settings.s3_region,
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        )

    async def create_multipart(self, key: str, content_type: str) -> str:
        """Abre um multipart upload e devolve o `UploadId`."""
        response = await run_in_threadpool(
            self._s3.create_multipart_upload, Bucket=self.bucket, Key=key, ContentType=content_type
        )
        return response["UploadId"]

    async def upload_part(self, key: str, upload_id: str, part_number: int, body: bytes) -> str:
        """Grava uma parte e devolve o `ETag`."""
        response = await run_in_threadpool(
            self._s3.upload_part, Bucket=self.bucket, Key=key, UploadId=upload_id, PartNumber=part_number, Body=body
        )
        return response["ETag"]

    async def list_parts(self, key: str, upload_id: str) -> list[StoredPart]:
        """Partes já confirmadas, em ordem."""

        def collect() -> list[StoredPart]:
            parts: list[StoredPart] = []
            marker = 0
            while True:
                page = self._s3.list_parts(Bucket=self.bucket, Key=key, UploadId=upload_id, PartNumberMarker=marker)
                parts.extend(StoredPart(p["PartNumber"], p["ETag"], p["Size"]) for p in page.get("Parts", []))
                if not page.get("IsTruncated"):
                    return parts
                marker = page["NextPartNumberMarker"]

        return await run_in_threadpool(collect)

    async def complete_multipart(self, key: str, upload_id: str, parts: list[tuple[int, str]]) -> None:
        """Monta o objeto a partir das partes `(número, etag)`."""
        await run_in_threadpool(
            self._s3.complete_multipart_upload,
            Bucket=self.bucket,
            Key=key,
            UploadId=upload_id,
            MultipartUpload={"Parts": [{"PartNumber": n, "ETag": etag} for n, etag in parts]},
        )

    async def abort_multipart(self, key: str, upload_id: str) -> None:
        """Descarta um multipart upload e as partes; já descartado não é erro."""
        try:
            await run_in_threadpool(self._s3.abort_multipart_upload, Bucket=self.bucket, Key=key, UploadId=upload_id)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") != "NoSuchUpload":
                raise

    async def sha256(self, key: str) -> str:
        """SHA-256 (hex) do objeto, lido em streaming."""

        def digest() -> str:
            body = self._s3.get_object(Bucket=self.bucket, Key=key)["Body"]
            hasher = hashlib.sha256()
            for chunk in body.iter_chunks(_CHUNK):
                hasher.update(chunk)
            return hasher.hexdigest()

        return await run_in_threadpool(digest)

    async def read_json(self, key: str) -> Any:  # noqa: ANN401 — JSON arbitrário do worker
        """Lê e decodifica um objeto JSON."""

        def read() -> Any:  # noqa: ANN401
            return json.loads(self._s3.get_object(Bucket=self.bucket, Key=key)["Body"].read())

        return await run_in_threadpool(read)

    async def put_bytes(self, key: str, body: bytes, content_type: str) -> None:
        """Grava um objeto pequeno."""
        await run_in_threadpool(self._s3.put_object, Bucket=self.bucket, Key=key, Body=body, ContentType=content_type)

    async def open_range(self, key: str, byte_range: str | None) -> ObjectRange:
        """Abre o objeto (ou um trecho `bytes=a-b`) para streaming."""
        kwargs: dict[str, Any] = {"Bucket": self.bucket, "Key": key}
        if byte_range:
            kwargs["Range"] = byte_range
        response = await run_in_threadpool(self._s3.get_object, **kwargs)
        return ObjectRange(
            chunks=response["Body"].iter_chunks(_CHUNK),
            content_length=response["ContentLength"],
            content_range=response.get("ContentRange"),
            content_type=response.get("ContentType") or "application/octet-stream",
        )

    async def delete_keys(self, keys: list[str]) -> None:
        """Apaga as chaves (as ausentes são ignoradas), em lotes do limite do S3."""

        def delete() -> None:
            for start in range(0, len(keys), _DELETE_BATCH):
                batch = keys[start : start + _DELETE_BATCH]
                self._s3.delete_objects(
                    Bucket=self.bucket, Delete={"Objects": [{"Key": k} for k in batch], "Quiet": True}
                )

        if keys:
            await run_in_threadpool(delete)

    async def delete_artifacts(self, recording_id: UUID | str) -> None:
        """Apaga os artefatos do worker GPU de uma gravação (a transcrição bruta e os embeddings)."""
        await self.delete_recording(None, recording_id)

    async def delete_recording(self, key: str | None, recording_id: UUID | str) -> None:
        """Apaga o áudio e os artefatos do worker de uma gravação."""

        def listed() -> list[str]:
            keys = [key] if key else []
            prefix = artifacts_prefix(recording_id)
            for page in self._s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
                keys.extend(obj["Key"] for obj in page.get("Contents", []))
            return keys

        await self.delete_keys(await run_in_threadpool(listed))
