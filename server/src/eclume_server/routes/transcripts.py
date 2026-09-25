"""Transcrições: listagem incremental (`?since=`), leitura completa e export em Markdown."""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import exists, select, tuple_
from sqlalchemy.ext.asyncio import AsyncConnection

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.pagination import Cursor, Limit, decode_cursor, page
from eclume_server.problems import not_found
from eclume_server.serialize import Row
from eclume_server.transcripts import render_markdown, summary_json, transcript_json, transcript_select

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("transcripts:read"))]


async def _speakers(conn: AsyncConnection, transcript_ids: list[UUID]) -> dict[UUID, list[Row]]:
    rows = (
        await conn.execute(
            select(t.speakers)
            .where(t.speakers.c.transcript_id.in_(transcript_ids))
            .order_by(t.speakers.c.transcript_id, t.speakers.c.position)
        )
    ).mappings()
    grouped: dict[UUID, list[Row]] = {transcript_id: [] for transcript_id in transcript_ids}
    for row in rows:
        grouped[row["transcript_id"]].append(row)
    return grouped


async def _full(conn: AsyncConnection, transcript_id: UUID, *, words: bool) -> dict[str, Any]:
    row = (await conn.execute(transcript_select().where(t.transcripts.c.id == transcript_id))).mappings().first()
    if row is None:
        raise not_found("Transcrição inexistente ou sem acesso.")
    speakers = (await _speakers(conn, [transcript_id]))[transcript_id]
    segments = (
        (
            await conn.execute(
                select(t.segments).where(t.segments.c.transcript_id == transcript_id).order_by(t.segments.c.position)
            )
        )
        .mappings()
        .all()
    )
    return transcript_json(row, speakers, list(segments), words=words)


@router.get("/transcripts")
async def list_transcripts(
    principal: Reader,
    ctx: Ctx,
    cursor: Cursor = None,
    limit: Limit = 50,
    since: datetime | None = None,
    person: UUID | None = None,
    recording_id: UUID | None = None,
) -> dict[str, Any]:
    """Transcrições visíveis, em ordem crescente de `(updated_at, id)`; `since` é inclusivo."""
    c = t.transcripts.c
    query = transcript_select().order_by(c.updated_at, c.id).limit(limit + 1)
    if since is not None:
        query = query.where(c.updated_at >= since)
    if recording_id is not None:
        query = query.where(c.recording_id == recording_id)
    if person is not None:
        query = query.where(exists().where(t.speakers.c.transcript_id == c.id, t.speakers.c.person_id == person))
    if cursor:
        query = query.where(tuple_(c.updated_at, c.id) > decode_cursor(cursor))
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        rows = list((await conn.execute(query)).mappings().all())
        speakers = await _speakers(conn, [row["id"] for row in rows[:limit]])
    items = [summary_json(row, speakers.get(row["id"], [])) for row in rows]
    return page(items, rows, limit, "updated_at")


@router.get("/transcripts/{transcript_id}")
async def get_transcript(
    transcript_id: UUID, principal: Reader, ctx: Ctx, include: Literal["words"] | None = None
) -> dict[str, Any]:
    """Transcrição completa; `include=words` traz as palavras com tempo."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        return await _full(conn, transcript_id, words=include == "words")


def _filename(title: str) -> str:
    ascii_title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_title.lower()).strip("-")
    return f"{slug or 'transcricao'}.md"


@router.get("/transcripts/{transcript_id}/export")
async def export_transcript(
    transcript_id: UUID,
    export_format: Annotated[Literal["md"], Query(alias="format")],
    principal: Reader,
    ctx: Ctx,
) -> Response:
    """Exporta a transcrição (`md`: frontmatter YAML e uma linha por segmento)."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        transcript = await _full(conn, transcript_id, words=False)
    del export_format  # só `md` existe na v1; formatos novos entram de forma aditiva
    return Response(
        render_markdown(transcript),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{_filename(transcript["title"])}"'},
    )
