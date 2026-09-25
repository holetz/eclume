"""Upload resumível em partes (multipart S3 orquestrado pela API), com dedup e retomada por hash.

A URL de cada parte é o `PUT /api/v1/uploads/{id}/parts/{n}` da própria API, assinado como um
pré-assinado do S3 (`?expires=&sig=`): a URL se autoriza sozinha e dispensa credencial e CSRF.
"""

from __future__ import annotations

import math
import time
from datetime import UTC, datetime, timedelta
from pathlib import PurePath
from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Path, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.pagination import iso
from eclume_server.problems import conflict, forbidden, invalid_field, not_found, unauthorized, validation_failed
from eclume_server.recordings import get_visible, insert_job, render
from eclume_server.security import sign, signature_matches
from eclume_server.serialize import Row
from eclume_server.storage import audio_key

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Writer = Annotated[Principal, Depends(requires("recordings:write"))]
PartNumber = Annotated[int, Path(ge=1, le=10000)]

MAX_PARTS = 10_000
FIRST_PART_URLS = 100
LANGUAGE = r"^[a-z]{2,3}(-[A-Z]{2})?$"


class Capture(BaseModel):
    """Schema `Capture`."""

    meeting_app: Literal["teams", "meet", "zoom", "other"] | None = None
    device_name: str | None = None
    client_version: str | None = None


class UploadCreate(BaseModel):
    """Schema `UploadCreate`."""

    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(pattern=r"^(audio|video)/[A-Za-z0-9.+-]+(\s*;.*)?$")
    size_bytes: int = Field(ge=1)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    title: str | None = Field(default=None, min_length=1)
    recorded_at: datetime | None = None
    duration_ms: int | None = Field(default=None, ge=0)
    language: str | None = Field(default=None, pattern=LANGUAGE)
    source: Literal["desktop", "upload", "api"] | None = None
    capture: Capture | None = None
    tags: list[Annotated[str, Field(min_length=1)]] = Field(default_factory=list)
    collection_ids: list[UUID] = Field(default_factory=list)
    metadata: dict[str, str] = Field(default_factory=dict)


class PartUrlsRequest(BaseModel):
    """Schema `PartUrlsRequest`."""

    part_numbers: list[Annotated[int, Field(ge=1, le=MAX_PARTS)]] = Field(min_length=1, max_length=1000)


class CompletedPart(BaseModel):
    """Item de `UploadComplete.parts`."""

    part_number: int = Field(ge=1, le=MAX_PARTS)
    etag: str


class UploadComplete(BaseModel):
    """Schema `UploadComplete`."""

    parts: list[CompletedPart] = Field(min_length=1)


def _now() -> datetime:
    return datetime.now(UTC)


def _status(row: Row) -> str:
    if row["status"] == "in_progress" and row["expires_at"] <= _now():
        return "expired"
    return row["status"]


def _part_size(row: Row, part_number: int) -> int:
    """Tamanho esperado da parte: `part_size`, menos a última, que leva o resto."""
    if part_number < row["part_count"]:
        return row["part_size"]
    return row["size_bytes"] - row["part_size"] * (row["part_count"] - 1)


def _part_url(ctx: AppContext, request: Request, row: Row, part_number: int) -> dict[str, Any]:
    expires_at = min(_now() + timedelta(seconds=ctx.settings.part_url_ttl_seconds), row["expires_at"])
    expires = int(expires_at.timestamp())
    base = (ctx.settings.public_url or str(request.base_url)).rstrip("/")
    sig = sign(ctx.settings.secret_key, "part", row["id"], part_number, expires)
    return {
        "part_number": part_number,
        "method": "PUT",
        "url": f"{base}/api/v1/uploads/{row['id']}/parts/{part_number}?expires={expires}&sig={sig}",
        "headers": {"Content-Type": "application/octet-stream"},
        "expires_at": iso(datetime.fromtimestamp(expires, UTC)),
    }


async def _received(ctx: AppContext, row: Row) -> list[dict[str, Any]]:
    if _status(row) != "in_progress":
        return []
    parts = await ctx.storage.list_parts(row["audio_key"], row["s3_upload_id"])
    return [{"part_number": p.part_number, "etag": p.etag, "size_bytes": p.size_bytes} for p in parts]


def upload_json(row: Row, received: list[dict[str, Any]], parts: list[dict[str, Any]]) -> dict[str, Any]:
    """Schema `Upload`."""
    return {
        "id": str(row["id"]),
        "status": _status(row),
        "filename": row["filename"],
        "content_type": row["content_type"],
        "size_bytes": row["size_bytes"],
        "sha256": row["sha256"],
        "part_size": row["part_size"],
        "part_count": row["part_count"],
        "parts_received": received,
        "parts": parts,
        "recording_id": str(row["recording_id"]) if row["recording_id"] else None,
        "expires_at": iso(row["expires_at"]),
        "created_at": iso(row["created_at"]),
    }


async def _resume(ctx: AppContext, request: Request, row: Row) -> dict[str, Any]:
    received = await _received(ctx, row)
    done = {part["part_number"] for part in received}
    pending = [n for n in range(1, row["part_count"] + 1) if n not in done][:FIRST_PART_URLS]
    return upload_json(row, received, [_part_url(ctx, request, row, n) for n in pending])


async def _get_upload(conn: AsyncConnection, upload_id: UUID, *, lock: bool = False) -> Any:  # noqa: ANN401
    query = select(t.uploads).where(t.uploads.c.id == upload_id)
    if lock:
        query = query.with_for_update()
    row = (await conn.execute(query)).mappings().first()
    if row is None:
        raise not_found("Upload inexistente ou sem acesso.")
    return row


def _require_open(row: Row) -> None:
    status = _status(row)
    if status == "expired":
        raise conflict("O upload expirou; comece outro.", code="upload_expired")
    if status != "in_progress":
        raise conflict(f"O upload está {status}.")


@router.post("/uploads", status_code=201)
async def create_upload(
    body: UploadCreate, request: Request, response: Response, principal: Writer, ctx: Ctx
) -> dict[str, Any]:
    """Inicia um upload; mesmo hash de uma gravação do usuário deduplica (200), de um upload aberto retoma."""
    if body.collection_ids:
        # Coleções nascem na spec pessoas-organizacao-e-busca: hoje nenhum id existe.
        raise invalid_field("collection_ids", "coleção inexistente")
    part_size = ctx.settings.upload_part_size
    part_count = math.ceil(body.size_bytes / part_size)
    if part_count > MAX_PARTS:
        raise invalid_field("size_bytes", f"arquivo maior que {MAX_PARTS} partes de {part_size} bytes")
    now = _now()
    expires_at = now + timedelta(days=ctx.settings.upload_ttl_days)
    request_fields = body.model_dump(mode="json", exclude={"filename", "content_type", "size_bytes", "sha256"})
    base = {
        "org_id": principal.org_id,
        "owner_id": principal.user_id,
        "filename": body.filename,
        "content_type": body.content_type,
        "size_bytes": body.size_bytes,
        "sha256": body.sha256,
        "part_size": part_size,
        "request": request_fields,
        "expires_at": expires_at,
    }
    try:
        async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
            duplicate = (
                await conn.execute(
                    select(t.recordings.c.id).where(
                        t.recordings.c.owner_id == principal.user_id,
                        t.recordings.c.content_hash == f"sha256:{body.sha256}",
                    )
                )
            ).scalar()
            if duplicate is not None:
                row = (
                    (
                        await conn.execute(
                            insert(t.uploads)
                            .values(
                                **base,
                                status="deduplicated",
                                part_count=0,
                                new_recording_id=duplicate,
                                recording_id=duplicate,
                                completed_at=now,
                            )
                            .returning(t.uploads)
                        )
                    )
                    .mappings()
                    .one()
                )
                response.status_code = 200
                return upload_json(row, [], [])

            open_upload = (
                (
                    await conn.execute(
                        select(t.uploads)
                        .where(
                            t.uploads.c.owner_id == principal.user_id,
                            t.uploads.c.sha256 == body.sha256,
                            t.uploads.c.status == "in_progress",
                        )
                        .with_for_update()
                    )
                )
                .mappings()
                .first()
            )
            if open_upload is not None:
                if _status(open_upload) == "in_progress" and open_upload["size_bytes"] == body.size_bytes:
                    return await _resume(ctx, request, open_upload)
                await ctx.storage.abort_multipart(open_upload["audio_key"], open_upload["s3_upload_id"])
                await conn.execute(
                    update(t.uploads).where(t.uploads.c.id == open_upload["id"]).values(status="aborted")
                )

            recording_id = uuid4()
            key = audio_key(principal.org_id, principal.user_id, recording_id)
            s3_upload_id = await ctx.storage.create_multipart(key, body.content_type)
            row = (
                (
                    await conn.execute(
                        insert(t.uploads)
                        .values(
                            **base,
                            status="in_progress",
                            part_count=part_count,
                            new_recording_id=recording_id,
                            audio_key=key,
                            s3_upload_id=s3_upload_id,
                        )
                        .returning(t.uploads)
                    )
                )
                .mappings()
                .one()
            )
    except IntegrityError as exc:
        raise conflict("Outro upload deste arquivo começou ao mesmo tempo; tente de novo.") from exc
    pending = range(1, min(part_count, FIRST_PART_URLS) + 1)
    return upload_json(row, [], [_part_url(ctx, request, row, n) for n in pending])


@router.get("/uploads/{upload_id}")
async def get_upload(upload_id: UUID, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Estado do upload, com as partes já confirmadas pelo armazenamento."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        row = await _get_upload(conn, upload_id)
    return upload_json(row, await _received(ctx, row), [])


@router.delete("/uploads/{upload_id}", status_code=204)
async def abort_upload(upload_id: UUID, principal: Writer, ctx: Ctx) -> Response:
    """Aborta um upload em andamento e descarta as partes; nos demais estados, nada muda."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        row = await _get_upload(conn, upload_id, lock=True)
        if row["status"] == "in_progress":
            await ctx.storage.abort_multipart(row["audio_key"], row["s3_upload_id"])
            await conn.execute(update(t.uploads).where(t.uploads.c.id == upload_id).values(status="aborted"))
    return Response(status_code=204)


@router.post("/uploads/{upload_id}/part-urls")
async def create_part_urls(
    upload_id: UUID, body: PartUrlsRequest, request: Request, principal: Writer, ctx: Ctx
) -> dict[str, Any]:
    """URLs novas para as partes pedidas (inclusive para trocar URLs expiradas)."""
    if len(set(body.part_numbers)) != len(body.part_numbers):
        raise invalid_field("part_numbers", "números repetidos")
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        row = await _get_upload(conn, upload_id)
    _require_open(row)
    beyond = [n for n in body.part_numbers if n > row["part_count"]]
    if beyond:
        raise invalid_field("part_numbers", f"o upload tem {row['part_count']} partes")
    return {"parts": [_part_url(ctx, request, row, n) for n in body.part_numbers]}


@router.put("/uploads/{upload_id}/parts/{part_number}")
async def put_part(
    upload_id: UUID,
    part_number: PartNumber,
    request: Request,
    ctx: Ctx,
    expires: int | None = None,
    sig: str | None = None,
) -> Response:
    """Grava uma parte; a assinatura da URL é a autorização."""
    if (
        expires is None
        or not sig
        or not signature_matches(ctx.settings.secret_key, sig, "part", upload_id, part_number, expires)
    ):
        raise unauthorized("URL de parte inválida: use a `url` recebida do upload.")
    if expires < time.time():
        raise forbidden("URL de parte expirada: peça outra em part-urls.")
    async with system_tx(ctx.engine) as conn:
        row = await _get_upload(conn, upload_id)
    _require_open(row)
    if part_number > row["part_count"]:
        raise conflict(f"O upload tem {row['part_count']} partes.")
    expected = _part_size(row, part_number)
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) != expected:
        raise conflict(f"A parte {part_number} deve ter {expected} bytes.")
    data = await request.body()
    if len(data) != expected:
        raise conflict(f"A parte {part_number} deve ter {expected} bytes.")
    etag = await ctx.storage.upload_part(row["audio_key"], row["s3_upload_id"], part_number, data)
    return Response(status_code=200, headers={"ETag": etag})


@router.post("/uploads/{upload_id}/complete", status_code=201)
async def complete_upload(upload_id: UUID, body: UploadComplete, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Monta o objeto, confere o SHA-256, cria a gravação e enfileira a transcrição."""
    enqueue: tuple[str, dict[str, Any]] | None = None
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        row = await _get_upload(conn, upload_id, lock=True)
        if row["status"] in {"completed", "deduplicated"}:
            recording_id = row["recording_id"]
        else:
            _require_open(row)
            await _check_parts(ctx, row, body)
            recording_id, enqueue = await _finish(ctx, conn, row, principal)
        recording = await get_visible(conn, recording_id)
    if enqueue is not None:
        await ctx.queue.enqueue_transcribe(recording_id, 1, *enqueue)
    return (await render(ctx, [recording]))[0]


async def _check_parts(ctx: AppContext, row: Row, body: UploadComplete) -> None:
    numbers = [part.part_number for part in body.parts]
    if sorted(numbers) != list(range(1, row["part_count"] + 1)):
        raise invalid_field("parts", f"informe cada uma das {row['part_count']} partes uma vez")
    stored = {
        part.part_number: part.etag for part in await ctx.storage.list_parts(row["audio_key"], row["s3_upload_id"])
    }
    errors = [
        {"field": f"parts[{i}].etag", "message": "parte ausente ou com ETag diferente do armazenado"}
        for i, part in enumerate(body.parts)
        if stored.get(part.part_number, "").strip('"') != part.etag.strip('"')
    ]
    if errors:
        raise validation_failed(errors)


async def _finish(
    ctx: AppContext,
    conn: AsyncConnection,
    row: Row,
    principal: Principal,
) -> tuple[UUID, tuple[str, dict[str, Any]] | None]:
    """Fecha o multipart, confere o hash e grava gravação e job. Devolve o que enfileirar."""
    key = row["audio_key"]
    parts = await ctx.storage.list_parts(key, row["s3_upload_id"])
    await ctx.storage.complete_multipart(key, row["s3_upload_id"], [(p.part_number, p.etag) for p in parts])
    actual = await ctx.storage.sha256(key)
    matches = actual == row["sha256"]
    requested = row["request"]
    recording_id = row["new_recording_id"]
    now = _now()
    capture = requested.get("capture")
    values = {
        "id": recording_id,
        "org_id": principal.org_id,
        "owner_id": principal.user_id,
        "title": requested.get("title") or PurePath(row["filename"]).stem or row["filename"],
        "status": "queued" if matches else "failed",
        "source": requested.get("source") or ("api" if principal.method == "pat" else "upload"),
        "recorded_at": datetime.fromisoformat(requested["recorded_at"]) if requested.get("recorded_at") else now,
        "duration_ms": requested.get("duration_ms"),
        "language": requested.get("language"),
        "size_bytes": row["size_bytes"],
        "content_type": row["content_type"],
        # Com hash divergente, a gravação guarda o hash real: o declarado segue livre para um novo upload.
        "content_hash": f"sha256:{actual}",
        "audio_key": key,
        "tags": requested.get("tags") or [],
        "collection_ids": [],
        "metadata": requested.get("metadata") or {},
        "capture": capture,
    }
    duplicate = (
        await conn.execute(
            select(t.recordings.c.id).where(
                t.recordings.c.owner_id == principal.user_id, t.recordings.c.content_hash == values["content_hash"]
            )
        )
    ).scalar()
    if duplicate is not None:
        # O conteúdo real já é de outra gravação do usuário: o upload vira deduplicado.
        await ctx.storage.delete_recording(key, recording_id)
        await conn.execute(
            update(t.uploads)
            .where(t.uploads.c.id == row["id"])
            .values(status="deduplicated", recording_id=duplicate, completed_at=now)
        )
        return duplicate, None
    await conn.execute(insert(t.recordings).values(**values))
    recording = {"id": recording_id, "org_id": principal.org_id, "language": values["language"]}
    error = None if matches else ("hash_mismatch", "O SHA-256 do arquivo recebido difere do declarado no upload.")
    options = await insert_job(conn, recording, 1, error=error)
    await conn.execute(
        update(t.uploads)
        .where(t.uploads.c.id == row["id"])
        .values(status="completed", recording_id=recording_id, completed_at=now)
    )
    return recording_id, ((key, options) if matches else None)
