"""Gravações: listar, obter, editar, excluir, áudio, retranscrever e compartilhar."""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request, Response
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, insert, select, tuple_, update
from sqlalchemy.exc import IntegrityError

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.pagination import Cursor, Limit, decode_cursor, encode_cursor, iso
from eclume_server.problems import conflict, forbidden, invalid_field, not_found, unauthorized
from eclume_server.recordings import (
    enqueue_transcription,
    get_visible,
    insert_job,
    recording_select,
    render,
    require_owner,
)
from eclume_server.routes.collections import check_collections
from eclume_server.routes.uploads import LANGUAGE
from eclume_server.security import sign, signature_matches
from eclume_server.serialize import Row, user_ref

router = APIRouter()
media_router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("recordings:read"))]
Writer = Annotated[Principal, Depends(requires("recordings:write"))]
Status = Literal["uploading", "queued", "processing", "transcribed", "failed"]
AUDIO_URL_TTL_SECONDS = 3600


class RecordingPatch(BaseModel):
    """Schema `RecordingPatch`."""

    title: str | None = Field(default=None, min_length=1)
    recorded_at: datetime | None = None
    language: str | None = Field(default=None, pattern=LANGUAGE)
    tags: list[Annotated[str, Field(min_length=1)]] | None = None
    collection_ids: list[UUID] | None = None
    metadata: dict[str, str] | None = None


class RetranscribeRequest(BaseModel):
    """Schema `RetranscribeRequest`."""

    language: str | None = Field(default=None, pattern=LANGUAGE)


class ShareCreate(BaseModel):
    """Schema `ShareCreate`."""

    target_type: Literal["group", "organization"]
    target_id: UUID | None = None


@router.get("/recordings")
async def list_recordings(
    principal: Reader,
    ctx: Ctx,
    cursor: Cursor = None,
    limit: Limit = 50,
    since: datetime | None = None,
    status: Status | None = None,
    owner: Literal["me", "shared", "all"] = "me",
    tag: str | None = None,
    collection: UUID | None = None,
) -> dict[str, Any]:
    """Gravações visíveis ao usuário, da mais recente para a mais antiga."""
    r = t.recordings.c
    query = recording_select().order_by(r.created_at.desc(), r.id.desc()).limit(limit + 1)
    if owner == "me":
        query = query.where(r.owner_id == principal.user_id)
    elif owner == "shared":
        query = query.where(r.owner_id != principal.user_id)
    if since is not None:
        query = query.where(r.updated_at >= since)
    if status == "processing":
        # `processing` é o `queued` com o worker já reportando progresso: filtra pelos dois e refina abaixo.
        query = query.where(r.status == "queued")
    elif status is not None:
        query = query.where(r.status == status)
    if tag is not None:
        query = query.where(r.tags.any(tag))
    if collection is not None:
        query = query.where(r.collection_ids.any(collection))
    if cursor:
        query = query.where(tuple_(r.created_at, r.id) < decode_cursor(cursor))
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        rows = list((await conn.execute(query)).mappings().all())
    has_more = len(rows) > limit
    rows = rows[:limit]
    items = await render(ctx, rows)
    if status in {"queued", "processing"}:
        items = [item for item in items if item["status"] == status]
    next_cursor = encode_cursor(rows[-1]["created_at"], rows[-1]["id"]) if has_more else None
    return {"items": items, "next_cursor": next_cursor}


@router.get("/recordings/{recording_id}")
async def get_recording(recording_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Gravação e estado do job."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        row = await get_visible(conn, recording_id)
    return (await render(ctx, [row]))[0]


@router.patch("/recordings/{recording_id}")
async def update_recording(recording_id: UUID, body: RecordingPatch, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Edita os metadados (listas e `metadata` substituem o valor inteiro). Só o dono."""
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise invalid_field("body", "informe ao menos um campo")
    for field, value in values.items():
        if value is None:
            raise invalid_field(field, "não pode ser nulo")
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        require_owner(await get_visible(conn, recording_id), principal)
        if "collection_ids" in values:
            await check_collections(conn, values["collection_ids"])
            values["collection_ids"] = list(dict.fromkeys(values["collection_ids"]))
        now = datetime.now(UTC)
        await conn.execute(
            update(t.recordings).where(t.recordings.c.id == recording_id).values(**values, updated_at=now)
        )
        # Título, data e tags aparecem na transcrição: `?since=` precisa enxergar a mudança.
        await conn.execute(
            update(t.transcripts).where(t.transcripts.c.recording_id == recording_id).values(updated_at=now)
        )
        row = await get_visible(conn, recording_id)
    return (await render(ctx, [row]))[0]


@router.delete("/recordings/{recording_id}", status_code=204)
async def delete_recording(recording_id: UUID, principal: Writer, ctx: Ctx) -> Response:
    """Exclui a gravação, a transcrição e o áudio. Só o dono."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        row = await get_visible(conn, recording_id)
        require_owner(row, principal)
        await conn.execute(delete(t.recordings).where(t.recordings.c.id == recording_id))
    await ctx.storage.delete_recording(row["audio_key"], recording_id)
    return Response(status_code=204)


@router.get("/recordings/{recording_id}/audio", status_code=302)
async def get_audio(recording_id: UUID, request: Request, principal: Reader, ctx: Ctx) -> RedirectResponse:
    """Redireciona para uma URL temporária e assinada do áudio, que aceita `Range`."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        await get_visible(conn, recording_id)
    expires = int(time.time()) + AUDIO_URL_TTL_SECONDS
    sig = sign(ctx.settings.secret_key, "audio", recording_id, expires)
    base = (ctx.settings.public_url or str(request.base_url)).rstrip("/")
    return RedirectResponse(
        f"{base}/media/recordings/{recording_id}/audio?expires={expires}&sig={sig}", status_code=302
    )


@media_router.get("/media/recordings/{recording_id}/audio", include_in_schema=False)
async def stream_audio(
    recording_id: UUID,
    ctx: Ctx,
    expires: int | None = None,
    sig: str | None = None,
    range_header: Annotated[str | None, Header(alias="Range")] = None,
) -> StreamingResponse:
    """Serve o áudio (URL assinada por `GET .../audio`), com suporte a `Range` para o player."""
    if (
        expires is None
        or not sig
        or not signature_matches(ctx.settings.secret_key, sig, "audio", recording_id, expires)
    ):
        raise unauthorized("URL de áudio inválida.")
    if expires < time.time():
        raise forbidden("URL de áudio expirada.")
    async with system_tx(ctx.engine) as conn:
        key = (await conn.execute(select(t.recordings.c.audio_key).where(t.recordings.c.id == recording_id))).scalar()
    if key is None:
        raise not_found("Gravação inexistente.")
    obj = await ctx.storage.open_range(
        key, range_header if range_header and range_header.startswith("bytes=") else None
    )
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(obj.content_length)}
    if obj.content_range:
        headers["Content-Range"] = obj.content_range
    return StreamingResponse(
        obj.chunks, status_code=206 if obj.content_range else 200, media_type=obj.content_type, headers=headers
    )


@router.post("/recordings/{recording_id}/retranscribe", status_code=202)
async def retranscribe(
    recording_id: UUID, principal: Writer, ctx: Ctx, body: RetranscribeRequest | None = None
) -> dict[str, Any]:
    """Transcreve de novo com a configuração atual; a transcrição sobe de `revision`. Só o dono."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        row = await get_visible(conn, recording_id)
        require_owner(row, principal)
        if row["job_state"] in {"queued", "running"}:
            raise conflict("Já há um job de transcrição em andamento.")
        if body is not None and body.language is not None:
            await conn.execute(
                update(t.recordings).where(t.recordings.c.id == recording_id).values(language=body.language)
            )
        transcript_revision = (
            await conn.execute(select(t.transcripts.c.revision).where(t.transcripts.c.recording_id == recording_id))
        ).scalar()
        revision = max(transcript_revision or 0, row["job_revision"] or 0) + 1
        language = body.language if body is not None and body.language else row["language"]
        options = await insert_job(conn, {"id": recording_id, "org_id": row["org_id"], "language": language}, revision)
        await conn.execute(
            update(t.recordings).where(t.recordings.c.id == recording_id).values(status="queued", updated_at=func.now())
        )
        refreshed = await get_visible(conn, recording_id)
    await enqueue_transcription(ctx, recording_id, revision, row["audio_key"], options)
    return (await render(ctx, [refreshed]))[0]


def _share_json(row: Row) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "target": {"type": row["target_type"], "id": str(row["target_id"]), "name": row["target_name"]},
        "permission": "read",
        "created_by": user_ref(row["created_by"], row["created_by_name"]),
        "created_at": iso(row["created_at"]),
    }


def _shares_select() -> Any:  # noqa: ANN401
    s = t.recording_shares.c
    creator = t.users.alias("creator")
    return (
        select(
            t.recording_shares,
            func.coalesce(s.group_id, s.org_id).label("target_id"),
            func.coalesce(t.groups.c.name, t.organizations.c.name).label("target_name"),
            creator.c.name.label("created_by_name"),
        )
        .select_from(
            t.recording_shares.join(creator, creator.c.id == s.created_by)
            .join(t.organizations, t.organizations.c.id == s.org_id)
            .outerjoin(t.groups, t.groups.c.id == s.group_id)
        )
        .order_by(s.created_at, s.id)
    )


@router.get("/recordings/{recording_id}/shares")
async def list_shares(recording_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Compartilhamentos da gravação; vazio é gravação privada."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        await get_visible(conn, recording_id)
        rows = (
            (await conn.execute(_shares_select().where(t.recording_shares.c.recording_id == recording_id)))
            .mappings()
            .all()
        )
    return {"items": [_share_json(row) for row in rows], "next_cursor": None}


@router.post("/recordings/{recording_id}/shares", status_code=201)
async def create_share(recording_id: UUID, body: ShareCreate, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Compartilha com um grupo ou com a organização (leitura). Só o dono."""
    group_id = None
    if body.target_type == "group":
        if body.target_id is None:
            raise invalid_field("target_id", "obrigatório para grupo")
        group_id = body.target_id
    try:
        async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
            require_owner(await get_visible(conn, recording_id), principal)
            if group_id is not None and (
                (await conn.execute(select(t.groups.c.id).where(t.groups.c.id == group_id))).first() is None
            ):
                raise not_found("Grupo inexistente.")
            share_id = (
                await conn.execute(
                    insert(t.recording_shares)
                    .values(
                        org_id=principal.org_id,
                        recording_id=recording_id,
                        target_type=body.target_type,
                        group_id=group_id,
                        created_by=principal.user_id,
                    )
                    .returning(t.recording_shares.c.id)
                )
            ).scalar_one()
            await conn.execute(
                update(t.recordings).where(t.recordings.c.id == recording_id).values(updated_at=func.now())
            )
            row = (await conn.execute(_shares_select().where(t.recording_shares.c.id == share_id))).mappings().one()
    except IntegrityError as exc:
        raise conflict("A gravação já está compartilhada com este alvo.") from exc
    return _share_json(row)


@router.delete("/recordings/{recording_id}/shares/{share_id}", status_code=204)
async def delete_share(recording_id: UUID, share_id: UUID, principal: Writer, ctx: Ctx) -> Response:
    """Desfaz um compartilhamento. Só o dono."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        require_owner(await get_visible(conn, recording_id), principal)
        result = await conn.execute(
            delete(t.recording_shares).where(
                t.recording_shares.c.id == share_id, t.recording_shares.c.recording_id == recording_id
            )
        )
        if result.rowcount == 0:
            raise not_found("Compartilhamento inexistente.")
        await conn.execute(update(t.recordings).where(t.recordings.c.id == recording_id).values(updated_at=func.now()))
    return Response(status_code=204)
