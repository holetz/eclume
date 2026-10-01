"""Upload resumível em partes (multipart S3 orquestrado pela API), com dedup e retomada por hash.

A URL de cada parte é o `PUT /api/v1/uploads/{id}/parts/{n}` da própria API, assinado como um
pré-assinado do S3 (`?expires=&sig=`): a URL se autoriza sozinha e dispensa credencial e CSRF.
"""

from __future__ import annotations

import asyncio
import math
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import PurePath
from typing import TYPE_CHECKING, Annotated, Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Path, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from eclume_server.agenda_types import apply_type
from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.dispatch import next_for
from eclume_server.fields import mark_edited
from eclume_server.markers import MAX_BATCH, MarkerInput, upsert_markers
from eclume_server.pagination import iso
from eclume_server.problems import (
    ApiProblemError,
    conflict,
    forbidden,
    invalid_field,
    not_found,
    payload_too_large,
    unauthorized,
    validation_failed,
)
from eclume_server.quotas import check_upload
from eclume_server.recordings import get_visible, insert_job, render
from eclume_server.routes.collections import check_collections
from eclume_server.security import sign, signature_matches
from eclume_server.serialize import Row
from eclume_server.storage import MultipartGoneError, audio_key

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

COMPLETING_TTL_S = 120
COMPLETING_RENEW_S = 30
COMPLETING_RETRY_S = 5

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Writer = Annotated[Principal, Depends(requires("recordings:write"))]
PartNumber = Annotated[int, Path(ge=1, le=10000)]

MAX_PARTS = 10_000
FIRST_PART_URLS = 100
# Um idioma (`pt`, `pt-BR`) ou `auto`: a engine detecta e a gravação guarda o detectado.
LANGUAGE = r"^(auto|[a-z]{2,3}(-[A-Z]{2})?)$"
Kind = Literal["meeting", "note"]
RecordedAtSource = Literal["capture", "file_metadata", "user", "upload"]


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
    recorded_at_source: RecordedAtSource | None = None
    kind: Kind | None = None
    agenda_type_id: UUID | None = None
    markers: list[MarkerInput] = Field(default_factory=list, max_length=MAX_BATCH)
    duration_ms: int | None = Field(default=None, ge=0)
    language: str | None = Field(default=None, pattern=LANGUAGE)
    source: Literal["desktop", "mobile", "upload", "api"] | None = None
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


def _expired() -> Exception:
    return conflict("O upload expirou; comece outro.", code="upload_expired")


async def _expire(ctx: AppContext, upload_id: UUID) -> None:
    """O multipart sumiu do bucket (vencido no MinIO ou abortado): o upload fica `expired`."""
    async with system_tx(ctx.engine) as conn:
        await conn.execute(
            update(t.uploads)
            .where(t.uploads.c.id == upload_id, t.uploads.c.status == "in_progress")
            .values(status="expired")
        )


def _require_open(row: Row) -> None:
    status = _status(row)
    if status == "expired":
        raise _expired()
    if status != "in_progress":
        raise conflict(f"O upload está {status}.")


@router.post("/uploads", status_code=201)
async def create_upload(
    body: UploadCreate, request: Request, response: Response, principal: Writer, ctx: Ctx
) -> dict[str, Any]:
    """Inicia um upload; mesmo hash de uma gravação do usuário deduplica (200), de um upload aberto retoma."""
    part_size = ctx.settings.upload_part_size
    part_count = math.ceil(body.size_bytes / part_size)
    if part_count > MAX_PARTS:
        raise invalid_field("size_bytes", f"arquivo maior que {MAX_PARTS} partes de {part_size} bytes")
    if body.recorded_at is None and body.recorded_at_source not in {None, "upload"}:
        raise invalid_field("recorded_at_source", "sem recorded_at, a data é a do envio (upload)")
    now = _now()
    expires_at = now + timedelta(days=ctx.settings.upload_ttl_days)
    request_fields = body.model_dump(mode="json", exclude={"filename", "content_type", "size_bytes", "sha256"})
    base = {
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
        async with user_tx(ctx.engine, principal.user_id) as conn:
            await check_collections(conn, body.collection_ids)
            if body.agenda_type_id is not None and await _agenda_type(conn, body.agenda_type_id) is None:
                raise invalid_field("agenda_type_id", "tipo de agenda inexistente ou sem acesso")
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
                # O app pode ter caído depois de subir o áudio: os marcadores entram na gravação existente.
                await _add_markers(conn, duplicate, request_fields, principal)
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
                closed = "aborted"
                if _status(open_upload) == "in_progress" and open_upload["size_bytes"] == body.size_bytes:
                    try:
                        return await _resume(ctx, request, open_upload)
                    except MultipartGoneError:
                        # O multipart sumiu do bucket: este upload expira e outro começa.
                        closed = "expired"
                else:
                    await ctx.storage.abort_multipart(open_upload["audio_key"], open_upload["s3_upload_id"])
                await conn.execute(update(t.uploads).where(t.uploads.c.id == open_upload["id"]).values(status=closed))

            await check_upload(conn, principal.user_id, body.size_bytes)
            recording_id = uuid4()
            key = audio_key(principal.user_id, recording_id)
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
    async with user_tx(ctx.engine, principal.user_id) as conn:
        row = await _get_upload(conn, upload_id)
    try:
        received = await _received(ctx, row)
    except MultipartGoneError:
        await _expire(ctx, upload_id)
        return upload_json({**row, "status": "expired"}, [], [])
    return upload_json(row, received, [])


@router.delete("/uploads/{upload_id}", status_code=204)
async def abort_upload(upload_id: UUID, principal: Writer, ctx: Ctx) -> Response:
    """Aborta um upload em andamento e descarta as partes; nos demais estados, nada muda."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
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
    async with user_tx(ctx.engine, principal.user_id) as conn:
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
    data = await _read_part(request, expected)
    if len(data) != expected:
        raise conflict(f"A parte {part_number} deve ter {expected} bytes.")
    try:
        etag = await ctx.storage.upload_part(row["audio_key"], row["s3_upload_id"], part_number, data)
    except MultipartGoneError:
        await _expire(ctx, upload_id)
        raise _expired() from None
    return Response(status_code=200, headers={"ETag": etag})


async def _read_part(request: Request, expected: int) -> bytes:
    """O corpo da parte, lido em pedaços; passar de `expected` é 413 sem ler o resto."""
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > expected:
            raise payload_too_large(expected)
    return bytes(data)


@asynccontextmanager
async def _completing(ctx: AppContext, upload_id: UUID) -> AsyncIterator[None]:
    """Trava de um `complete` em andamento, renovada enquanto o S3 trabalha.

    Outro `complete` com a trava presa recebe 409 `upload_completing`; a trava de um processo morto
    vence em `COMPLETING_TTL_S` e o próximo `complete` retoma (o passo do S3 é idempotente).
    """
    redis = ctx.queue.pool
    key = f"eclume:upload:completing:{upload_id}"
    token = uuid4().hex
    if not await redis.set(key, token, nx=True, ex=COMPLETING_TTL_S):
        raise ApiProblemError(
            409,
            "upload_completing",
            "Outro pedido está concluindo este upload; tente de novo em instantes.",
            headers={"Retry-After": str(COMPLETING_RETRY_S)},
        )

    async def renew() -> None:
        while True:
            await asyncio.sleep(COMPLETING_RENEW_S)
            await redis.expire(key, COMPLETING_TTL_S)

    renewal = asyncio.create_task(renew())
    try:
        yield
    finally:
        renewal.cancel()
        if await redis.get(key) == token.encode():
            await redis.delete(key)


@router.post("/uploads/{upload_id}/complete", status_code=201)
async def complete_upload(upload_id: UUID, body: UploadComplete, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Monta o objeto, confere o SHA-256, cria a gravação e enfileira a transcrição.

    Em três passos, sem S3 dentro de transação: lê o upload; sob a trava, monta o multipart e calcula
    o hash; numa transação curta com `FOR UPDATE`, grava gravação e job.
    """
    async with user_tx(ctx.engine, principal.user_id) as conn:
        row = await _get_upload(conn, upload_id)
        done = row["status"] in {"completed", "deduplicated"}
        recording = await get_visible(conn, row["recording_id"]) if done else None
    if recording is not None:
        return (await render(ctx, principal.user_id, [recording]))[0]
    _require_open(row)
    dispatch = False
    async with _completing(ctx, upload_id):
        try:
            actual = await _assemble(ctx, row, body)
        except MultipartGoneError:
            await _expire(ctx, upload_id)
            raise _expired() from None
        async with user_tx(ctx.engine, principal.user_id) as conn:
            row = await _get_upload(conn, upload_id, lock=True)
            if row["status"] in {"completed", "deduplicated"}:
                recording_id, discard = row["recording_id"], False
            else:
                _require_open(row)
                recording_id, dispatch, discard = await _finish(conn, row, principal, actual)
            recording = await get_visible(conn, recording_id)
    if discard:
        await ctx.storage.delete_recording(row["audio_key"], row["new_recording_id"])
    if dispatch:
        await next_for(ctx.engine, ctx.queue.pool, principal.user_id)
    return (await render(ctx, principal.user_id, [recording]))[0]


async def _assemble(ctx: AppContext, row: Row, body: UploadComplete) -> str:
    """Fecha o multipart (se ainda não montado) e devolve o SHA-256 do objeto."""
    key = row["audio_key"]
    if not await _parts_or_assembled(ctx, row, body):
        parts = await ctx.storage.list_parts(key, row["s3_upload_id"])
        await ctx.storage.complete_multipart(key, row["s3_upload_id"], [(p.part_number, p.etag) for p in parts])
    return await ctx.storage.sha256(key)


async def _parts_or_assembled(ctx: AppContext, row: Row, body: UploadComplete) -> bool:
    """Confere as partes; devolve `True` se o objeto já foi montado por um `complete` anterior.

    Multipart sumido com o objeto presente é o `complete` cujo commit falhou depois de montar: segue
    sem remontar. Sumido sem objeto é `MultipartGoneError` (o upload expira).
    """
    try:
        await _check_parts(ctx, row, body)
    except MultipartGoneError:
        if not await ctx.storage.head_object(row["audio_key"]):
            raise
        return True
    return False


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


async def _agenda_type(conn: AsyncConnection, agenda_type_id: UUID) -> Row | None:
    return (await conn.execute(select(t.agenda_types).where(t.agenda_types.c.id == agenda_type_id))).mappings().first()


async def _add_markers(
    conn: AsyncConnection, recording_id: UUID, requested: dict[str, Any], principal: Principal
) -> None:
    """Os marcadores pedidos no upload, com o dispositivo da captura."""
    await upsert_markers(
        conn,
        owner_id=principal.user_id,
        recording_id=recording_id,
        markers=requested.get("markers") or [],
        device_name=(requested.get("capture") or {}).get("device_name"),
        created_by=principal.user_id,
    )


def recorded_at_source(requested: dict[str, Any], source: str) -> str:
    """A origem pedida, ou a regra: o relógio do app que gravou, a data informada, ou a hora do envio."""
    if requested.get("recorded_at_source"):
        return requested["recorded_at_source"]
    if not requested.get("recorded_at"):
        return "upload"
    return "capture" if source in {"desktop", "mobile"} else "user"


async def _finish(conn: AsyncConnection, row: Row, principal: Principal, actual: str) -> tuple[UUID, bool, bool]:
    """Grava gravação e job do objeto montado com hash `actual`.

    Devolve a gravação, se há job a despachar e se o objeto, duplicado, deve ser apagado depois do
    commit.
    """
    key = row["audio_key"]
    matches = actual == row["sha256"]
    requested = row["request"]
    recording_id = row["new_recording_id"]
    # Coleções pedidas na criação que o usuário excluiu enquanto o upload andava ficam de fora.
    wanted = [UUID(c) for c in dict.fromkeys(requested.get("collection_ids") or [])]
    existing = set((await conn.execute(select(t.collections.c.id).where(t.collections.c.id.in_(wanted)))).scalars())
    now = _now()
    capture = requested.get("capture")
    source = requested.get("source") or ("api" if principal.method == "pat" else "upload")
    values = {
        "id": recording_id,
        "owner_id": principal.user_id,
        "title": requested.get("title") or PurePath(row["filename"]).stem or row["filename"],
        "status": "queued" if matches else "failed",
        "kind": requested.get("kind") or "meeting",
        "source": source,
        "recorded_at": datetime.fromisoformat(requested["recorded_at"]) if requested.get("recorded_at") else now,
        "recorded_at_source": recorded_at_source(requested, source),
        "duration_ms": requested.get("duration_ms"),
        "language": requested.get("language"),
        "size_bytes": row["size_bytes"],
        "content_type": row["content_type"],
        # Com hash divergente, a gravação guarda o hash real: o declarado segue livre para um novo upload.
        "content_hash": f"sha256:{actual}",
        "audio_key": key,
        "tags": requested.get("tags") or [],
        "collection_ids": [c for c in wanted if c in existing],
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
        await conn.execute(
            update(t.uploads)
            .where(t.uploads.c.id == row["id"])
            .values(status="deduplicated", recording_id=duplicate, completed_at=now)
        )
        await _add_markers(conn, duplicate, requested, principal)
        return duplicate, False, True
    await conn.execute(insert(t.recordings).values(**values))
    await _add_markers(conn, recording_id, requested, principal)
    # Título e tags pedidos no upload são do usuário; sem título (o nome do arquivo), o automático o troca.
    await mark_edited(
        conn, recording_id, principal.user_id, {key: requested[key] for key in ("title", "tags") if requested.get(key)}
    )
    # O tipo escolhido ao parar a gravação é do usuário (origem `edited`): dispensa a detecção.
    # Depois dos valores do usuário: o padrão de título não troca um título que ele escreveu.
    agenda_type = (
        await _agenda_type(conn, UUID(requested["agenda_type_id"])) if requested.get("agenda_type_id") else None
    )
    if agenda_type is not None:
        inserted = (await conn.execute(select(t.recordings).where(t.recordings.c.id == recording_id))).mappings().one()
        await apply_type(conn, inserted, agenda_type, "edited")
    recording = {"id": recording_id, "owner_id": principal.user_id, "language": values["language"]}
    error = None if matches else ("hash_mismatch", "O SHA-256 do arquivo recebido difere do declarado no upload.")
    await insert_job(conn, recording, 1, error=error)
    await conn.execute(
        update(t.uploads)
        .where(t.uploads.c.id == row["id"])
        .values(status="completed", recording_id=recording_id, completed_at=now)
    )
    return recording_id, matches, False
