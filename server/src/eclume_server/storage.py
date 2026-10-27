"""Object storage (S3/MinIO): the upload's multipart, hashing and reading the audio.

boto3 is synchronous; the coroutines here run the calls in a thread.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime  # noqa: TC003 — a dataclass field, resolved at runtime
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
# Key limit per S3 `DeleteObjects`.
_DELETE_BATCH = 1000


def audio_key(owner_id: UUID, recording_id: UUID) -> str:
    """The audio key: the recording lives under its owner (`users/{id}/...`).

    Recordings from the organization era keep the old key (`orgs/{org}/users/...`) in
    `recordings.audio_key`, which is always the source: the object does not move.
    """
    return f"users/{owner_id}/recordings/{recording_id}/audio"


# Root of the GPU worker artifacts: `recordings/{recording_id}/r{revision}/…` (and the old keys,
# without a revision, `recordings/{recording_id}/…`).
ARTIFACTS_ROOT = "recordings/"
EMBEDDINGS_FILE = "speaker_embeddings.json"


def artifacts_prefix(recording_id: UUID | str) -> str:
    """Prefix of a recording's GPU worker artifacts, for all revisions (job contract)."""
    return f"{ARTIFACTS_ROOT}{recording_id}/"


def revision_prefix(recording_id: UUID | str, revision: int) -> str:
    """Prefix of a revision's artifacts."""
    return f"{artifacts_prefix(recording_id)}r{revision}/"


class StorageDeleteError(Exception):
    """`DeleteObjects` returned keys that were not removed."""


class MultipartGoneError(Exception):
    """The multipart upload no longer exists in the bucket (`NoSuchUpload`: expired or aborted)."""


def _no_such_upload(exc: ClientError) -> bool:
    return exc.response.get("Error", {}).get("Code") == "NoSuchUpload"


@dataclass(frozen=True)
class StoredObject:
    """A bucket object with the date of its last write."""

    key: str
    last_modified: datetime


@dataclass(frozen=True)
class PendingMultipart:
    """A multipart upload in progress in the bucket."""

    key: str
    upload_id: str
    initiated: datetime


@dataclass(frozen=True)
class StoredPart:
    """A part the storage has already confirmed."""

    part_number: int
    etag: str
    size_bytes: int


@dataclass(frozen=True)
class ObjectRange:
    """Body (or slice) of an object, to serve with `Range`."""

    chunks: Iterator[bytes]
    content_length: int
    content_range: str | None
    content_type: str


class Storage:
    """Client of the eclume bucket."""

    def __init__(self, settings: Settings) -> None:
        """A boto3 client pointed at the configured S3 endpoint."""
        self.bucket = settings.s3_bucket
        self._s3 = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            region_name=settings.s3_region,
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
                # Without recent boto3's default CRC32: MinIO does not require it and it costs CPU per part.
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            ),
        )

    async def head_bucket(self) -> None:
        """The bucket answers (the health probe); fails with the boto3 exception."""
        await asyncio.to_thread(self._s3.head_bucket, Bucket=self.bucket)

    async def create_multipart(self, key: str, content_type: str) -> str:
        """Open a multipart upload and return the `UploadId`."""
        response = await run_in_threadpool(
            self._s3.create_multipart_upload, Bucket=self.bucket, Key=key, ContentType=content_type
        )
        return response["UploadId"]

    async def upload_part(self, key: str, upload_id: str, part_number: int, body: bytes | bytearray) -> str:
        """Write a part and return the `ETag`; a vanished multipart is `MultipartGoneError`."""
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
        """Parts already confirmed, in order; a vanished multipart is `MultipartGoneError`."""

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
        """Assemble the object from the `(number, etag)` parts; a vanished multipart is `MultipartGoneError`."""
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
        """Discard a multipart upload and its parts; already discarded is not an error."""
        try:
            await run_in_threadpool(self._s3.abort_multipart_upload, Bucket=self.bucket, Key=key, UploadId=upload_id)
        except ClientError as exc:
            if not _no_such_upload(exc):
                raise

    async def head_object(self, key: str) -> bool:
        """Whether the object exists."""
        return await self.object_size(key) is not None

    async def object_size(self, key: str) -> int | None:
        """The object's size in bytes, or `None` if it does not exist."""
        try:
            response = await run_in_threadpool(self._s3.head_object, Bucket=self.bucket, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise
        return response["ContentLength"]

    async def copy_object(self, source: str, target: str) -> None:
        """Copy the object within the bucket, server-side (managed copy, in parts if large)."""
        await run_in_threadpool(self._s3.copy, {"Bucket": self.bucket, "Key": source}, self.bucket, target)

    async def list_objects(self, prefix: str) -> list[StoredObject]:
        """The objects under `prefix`, with the date of their last write."""

        def listed() -> list[StoredObject]:
            objects: list[StoredObject] = []
            for page in self._s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
                objects.extend(StoredObject(obj["Key"], obj["LastModified"]) for obj in page.get("Contents", []))
            return objects

        return await run_in_threadpool(listed)

    async def list_multipart_uploads(self, prefix: str = "") -> list[PendingMultipart]:
        """The multipart uploads in progress in the bucket (under `prefix`)."""

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
        """SHA-256 (hex) of the object, read as a stream."""

        def digest() -> str:
            body = self._s3.get_object(Bucket=self.bucket, Key=key)["Body"]
            hasher = hashlib.sha256()
            for chunk in body.iter_chunks(_CHUNK):
                hasher.update(chunk)
            return hasher.hexdigest()

        return await run_in_threadpool(digest)

    async def read_json(self, key: str) -> Any:  # noqa: ANN401 — arbitrary JSON from the worker
        """Read and decode a JSON object."""

        def read() -> Any:  # noqa: ANN401
            return json.loads(self._s3.get_object(Bucket=self.bucket, Key=key)["Body"].read())

        return await run_in_threadpool(read)

    async def put_object(self, key: str, body: bytes, content_type: str) -> None:
        """Write a small object at once (the Agent's files)."""
        await run_in_threadpool(self._s3.put_object, Bucket=self.bucket, Key=key, Body=body, ContentType=content_type)

    async def open_range(self, key: str, byte_range: str | None) -> ObjectRange:
        """Open the object (or a `bytes=a-b` slice) for streaming."""
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
        """Delete the keys (missing ones are ignored), in batches of the S3 limit; a failing one raises."""

        def delete() -> None:
            for start in range(0, len(keys), _DELETE_BATCH):
                batch = keys[start : start + _DELETE_BATCH]
                response = self._s3.delete_objects(
                    Bucket=self.bucket, Delete={"Objects": [{"Key": k} for k in batch], "Quiet": True}
                )
                if errors := response.get("Errors"):
                    msg = f"{len(errors)} chave(s) não saíram do bucket: {errors[0].get('Code')} em {errors[0].get('Key')}"
                    raise StorageDeleteError(msg)

        if keys:
            await run_in_threadpool(delete)

    async def list_keys(self, prefix: str) -> list[str]:
        """All keys under `prefix`."""
        return [obj.key for obj in await self.list_objects(prefix)]

    async def delete_artifacts(self, recording_id: UUID | str) -> None:
        """Delete a recording's GPU worker artifacts (the raw transcript and the embeddings)."""
        await self.delete_recording(None, recording_id)

    async def delete_other_revisions(self, recording_id: UUID | str, revision: int) -> None:
        """Delete the recording's artifacts outside `r{revision}/`, including the old keys without a revision."""
        keep = revision_prefix(recording_id, revision)
        keys = await self.list_keys(artifacts_prefix(recording_id))
        await self.delete_keys([key for key in keys if not key.startswith(keep)])

    async def delete_embedding_objects(self, recording_ids: list[UUID] | None = None) -> int:
        """Delete the `speaker_embeddings.json` files (of every revision and the old keys): from the whole bucket or the recordings."""
        prefixes = [ARTIFACTS_ROOT] if recording_ids is None else [artifacts_prefix(rid) for rid in recording_ids]
        keys = [
            key for prefix in prefixes for key in await self.list_keys(prefix) if key.endswith(f"/{EMBEDDINGS_FILE}")
        ]
        await self.delete_keys(keys)
        return len(keys)

    async def delete_recording(self, key: str | None, recording_id: UUID | str) -> None:
        """Delete a recording's audio and worker artifacts, for all revisions."""
        keys = await self.list_keys(artifacts_prefix(recording_id))
        await self.delete_keys([key, *keys] if key else keys)
