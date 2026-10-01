"""Armazenamento de objetos (S3/MinIO): multipart do upload, hash e leitura do áudio.

O boto3 é síncrono; as corrotinas daqui rodam as chamadas numa thread.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime  # noqa: TC003 — campo de dataclass, resolvido em tempo de execução
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


def audio_key(owner_id: UUID, recording_id: UUID) -> str:
    """Chave do áudio: a gravação vive sob o dono (`users/{id}/...`).

    Gravações da época da organização guardam a chave antiga (`orgs/{org}/users/...`) em
    `recordings.audio_key`, que é sempre a fonte: o objeto não muda de lugar.
    """
    return f"users/{owner_id}/recordings/{recording_id}/audio"


# Raiz dos artefatos do worker GPU: `recordings/{recording_id}/r{revision}/…` (e as chaves antigas,
# sem revisão, `recordings/{recording_id}/…`).
ARTIFACTS_ROOT = "recordings/"
EMBEDDINGS_FILE = "speaker_embeddings.json"


def artifacts_prefix(recording_id: UUID | str) -> str:
    """Prefixo dos artefatos do worker GPU de uma gravação, de todas as revisões (contrato de jobs)."""
    return f"{ARTIFACTS_ROOT}{recording_id}/"


def revision_prefix(recording_id: UUID | str, revision: int) -> str:
    """Prefixo dos artefatos de uma revisão."""
    return f"{artifacts_prefix(recording_id)}r{revision}/"


class MultipartGoneError(Exception):
    """O multipart upload não existe mais no bucket (`NoSuchUpload`: vencido ou abortado)."""


def _no_such_upload(exc: ClientError) -> bool:
    return exc.response.get("Error", {}).get("Code") == "NoSuchUpload"


@dataclass(frozen=True)
class StoredObject:
    """Objeto do bucket com a data da última escrita."""

    key: str
    last_modified: datetime


@dataclass(frozen=True)
class PendingMultipart:
    """Multipart upload em andamento no bucket."""

    key: str
    upload_id: str
    initiated: datetime


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

    async def head_bucket(self) -> None:
        """O bucket responde (a sonda da saúde); falha com a exceção do boto3."""
        await asyncio.to_thread(self._s3.head_bucket, Bucket=self.bucket)

    async def create_multipart(self, key: str, content_type: str) -> str:
        """Abre um multipart upload e devolve o `UploadId`."""
        response = await run_in_threadpool(
            self._s3.create_multipart_upload, Bucket=self.bucket, Key=key, ContentType=content_type
        )
        return response["UploadId"]

    async def upload_part(self, key: str, upload_id: str, part_number: int, body: bytes) -> str:
        """Grava uma parte e devolve o `ETag`; multipart sumido é `MultipartGoneError`."""
        try:
            response = await run_in_threadpool(
                self._s3.upload_part, Bucket=self.bucket, Key=key, UploadId=upload_id, PartNumber=part_number, Body=body
            )
        except ClientError as exc:
            if _no_such_upload(exc):
                raise MultipartGoneError(upload_id) from exc
            raise
        return response["ETag"]

    async def list_parts(self, key: str, upload_id: str) -> list[StoredPart]:
        """Partes já confirmadas, em ordem; multipart sumido é `MultipartGoneError`."""

        def collect() -> list[StoredPart]:
            parts: list[StoredPart] = []
            marker = 0
            while True:
                page = self._s3.list_parts(Bucket=self.bucket, Key=key, UploadId=upload_id, PartNumberMarker=marker)
                parts.extend(StoredPart(p["PartNumber"], p["ETag"], p["Size"]) for p in page.get("Parts", []))
                if not page.get("IsTruncated"):
                    return parts
                marker = page["NextPartNumberMarker"]

        try:
            return await run_in_threadpool(collect)
        except ClientError as exc:
            if _no_such_upload(exc):
                raise MultipartGoneError(upload_id) from exc
            raise

    async def complete_multipart(self, key: str, upload_id: str, parts: list[tuple[int, str]]) -> None:
        """Monta o objeto a partir das partes `(número, etag)`; multipart sumido é `MultipartGoneError`."""
        try:
            await run_in_threadpool(
                self._s3.complete_multipart_upload,
                Bucket=self.bucket,
                Key=key,
                UploadId=upload_id,
                MultipartUpload={"Parts": [{"PartNumber": n, "ETag": etag} for n, etag in parts]},
            )
        except ClientError as exc:
            if _no_such_upload(exc):
                raise MultipartGoneError(upload_id) from exc
            raise

    async def abort_multipart(self, key: str, upload_id: str) -> None:
        """Descarta um multipart upload e as partes; já descartado não é erro."""
        try:
            await run_in_threadpool(self._s3.abort_multipart_upload, Bucket=self.bucket, Key=key, UploadId=upload_id)
        except ClientError as exc:
            if not _no_such_upload(exc):
                raise

    async def head_object(self, key: str) -> bool:
        """Se o objeto existe."""
        try:
            await run_in_threadpool(self._s3.head_object, Bucket=self.bucket, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return False
            raise
        return True

    async def list_objects(self, prefix: str) -> list[StoredObject]:
        """Os objetos sob `prefix`, com a data da última escrita."""

        def listed() -> list[StoredObject]:
            objects: list[StoredObject] = []
            for page in self._s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
                objects.extend(StoredObject(obj["Key"], obj["LastModified"]) for obj in page.get("Contents", []))
            return objects

        return await run_in_threadpool(listed)

    async def list_multipart_uploads(self, prefix: str = "") -> list[PendingMultipart]:
        """Os multipart uploads em andamento no bucket (sob `prefix`)."""

        def listed() -> list[PendingMultipart]:
            pending: list[PendingMultipart] = []
            paginator = self._s3.get_paginator("list_multipart_uploads")
            for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
                pending.extend(
                    PendingMultipart(item["Key"], item["UploadId"], item["Initiated"])
                    for item in page.get("Uploads", [])
                )
            return pending

        return await run_in_threadpool(listed)

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

    async def list_keys(self, prefix: str) -> list[str]:
        """Todas as chaves sob `prefix`."""
        return [obj.key for obj in await self.list_objects(prefix)]

    async def delete_artifacts(self, recording_id: UUID | str) -> None:
        """Apaga os artefatos do worker GPU de uma gravação (a transcrição bruta e os embeddings)."""
        await self.delete_recording(None, recording_id)

    async def delete_other_revisions(self, recording_id: UUID | str, revision: int) -> None:
        """Apaga os artefatos da gravação fora de `r{revision}/`, as chaves antigas sem revisão inclusive."""
        keep = revision_prefix(recording_id, revision)
        keys = await self.list_keys(artifacts_prefix(recording_id))
        await self.delete_keys([key for key in keys if not key.startswith(keep)])

    async def delete_embedding_objects(self) -> int:
        """Apaga todo `speaker_embeddings.json` do bucket (de toda revisão e das chaves antigas)."""
        keys = [key for key in await self.list_keys(ARTIFACTS_ROOT) if key.endswith(f"/{EMBEDDINGS_FILE}")]
        await self.delete_keys(keys)
        return len(keys)

    async def delete_recording(self, key: str | None, recording_id: UUID | str) -> None:
        """Apaga o áudio e os artefatos do worker de uma gravação, de todas as revisões."""
        keys = await self.list_keys(artifacts_prefix(recording_id))
        await self.delete_keys([key, *keys] if key else keys)
