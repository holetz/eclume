"""Busca full-text sobre os segmentos das transcrições do usuário."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db.session import user_tx
from eclume_server.pagination import Cursor, Limit, decode_position, encode_position
from eclume_server.problems import invalid_field
from eclume_server.search import SearchFilters, search

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("transcripts:read"))]


def _offset(cursor: str | None) -> int:
    if not cursor:
        return 0
    (value,) = decode_position(cursor, 1)
    if not value.isdigit():
        raise invalid_field("cursor", "cursor inválido")
    return int(value)


@router.get("/search")
async def search_segments(
    principal: Reader,
    ctx: Ctx,
    q: str | None = None,
    person: UUID | None = None,
    date_from: Annotated[datetime | None, Query(alias="from")] = None,
    date_to: Annotated[datetime | None, Query(alias="to")] = None,
    tag: str | None = None,
    collection: UUID | None = None,
    field: Annotated[list[str] | None, Query()] = None,
    cursor: Cursor = None,
    limit: Limit = 50,
) -> dict[str, Any]:
    """Trechos por relevância (`q`) ou, só com `person`, as falas da pessoa em ordem cronológica."""
    q = q.strip() if q else None
    if not q and person is None:
        raise invalid_field("q", "informe q ou person")
    offset = _offset(cursor)
    filters = SearchFilters(q, person, date_from, date_to, tag, collection, tuple(field or ()))
    async with user_tx(ctx.engine, principal.user_id) as conn:
        items = await search(conn, filters, offset, limit)
    next_cursor = encode_position(offset + limit) if len(items) > limit else None
    return {"items": items[:limit], "next_cursor": next_cursor}
