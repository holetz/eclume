"""Coleções do usuário e tags em uso nas gravações dele."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import any_, delete, func, insert, select, text, tuple_, update

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.pagination import Cursor, Limit, decode_named_position, encode_position, iso
from eclume_server.problems import invalid_field, not_found

if TYPE_CHECKING:
    from sqlalchemy import Select
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("recordings:read"))]
Writer = Annotated[Principal, Depends(requires("recordings:write"))]

_sort_name = func.lower(t.collections.c.name).label("sort_name")
_recording_count = (
    select(func.count())
    .select_from(t.recordings)
    .where(t.collections.c.id == any_(t.recordings.c.collection_ids))
    .scalar_subquery()
    .label("recording_count")
)


class CollectionCreate(BaseModel):
    """Schema `CollectionCreate`."""

    name: str = Field(min_length=1)
    description: str | None = None


class CollectionPatch(BaseModel):
    """Schema `CollectionPatch`."""

    name: str | None = Field(default=None, min_length=1)
    description: str | None = None


def _select() -> Select:
    """Coleções do usuário (a RLS só mostra as dele) com as gravações que as usam."""
    return select(t.collections, _sort_name, _recording_count)


def collection_json(row: Row) -> dict[str, Any]:
    """Schema `Collection`."""
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "description": row["description"],
        "recording_count": row["recording_count"],
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
    }


async def check_collections(conn: AsyncConnection, collection_ids: list[UUID]) -> None:
    """422 se algum id não for coleção do usuário da transação."""
    wanted = set(collection_ids)
    if not wanted:
        return
    found = set((await conn.execute(select(t.collections.c.id).where(t.collections.c.id.in_(wanted)))).scalars())
    if wanted - found:
        raise invalid_field("collection_ids", "coleção inexistente")


async def _get(conn: AsyncConnection, collection_id: UUID) -> Row:
    row = (await conn.execute(_select().where(t.collections.c.id == collection_id))).mappings().first()
    if row is None:
        raise not_found("Coleção inexistente ou sem acesso.")
    return row


@router.get("/collections")
async def list_collections(principal: Reader, ctx: Ctx, cursor: Cursor = None, limit: Limit = 50) -> dict[str, Any]:
    """Coleções do usuário, em ordem alfabética."""
    c = t.collections.c
    query = _select().order_by(func.lower(c.name), c.id).limit(limit + 1)
    if cursor:
        position = decode_named_position(cursor)
        query = query.where(tuple_(func.lower(c.name), c.id) > position)
    async with user_tx(ctx.engine, principal.user_id) as conn:
        rows = (await conn.execute(query)).mappings().all()
    next_cursor = encode_position(rows[limit - 1]["sort_name"], rows[limit - 1]["id"]) if len(rows) > limit else None
    return {"items": [collection_json(row) for row in rows[:limit]], "next_cursor": next_cursor}


@router.post("/collections", status_code=201)
async def create_collection(body: CollectionCreate, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Cria uma coleção do usuário."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        collection_id = (
            await conn.execute(
                insert(t.collections)
                .values(owner_id=principal.user_id, **body.model_dump())
                .returning(t.collections.c.id)
            )
        ).scalar_one()
        return collection_json(await _get(conn, collection_id))


@router.patch("/collections/{collection_id}")
async def update_collection(collection_id: UUID, body: CollectionPatch, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Renomeia ou descreve a coleção."""
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise invalid_field("body", "informe ao menos um campo")
    if "name" in values and values["name"] is None:
        raise invalid_field("name", "não pode ser nulo")
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await _get(conn, collection_id)
        await conn.execute(
            update(t.collections)
            .where(t.collections.c.id == collection_id)
            .values(**values, updated_at=datetime.now(UTC))
        )
        return collection_json(await _get(conn, collection_id))


@router.delete("/collections/{collection_id}", status_code=204)
async def delete_collection(collection_id: UUID, principal: Writer, ctx: Ctx) -> Response:
    """Exclui a coleção; as gravações ficam e só saem dela."""
    r = t.recordings.c
    async with user_tx(ctx.engine, principal.user_id) as conn:
        result = await conn.execute(delete(t.collections).where(t.collections.c.id == collection_id))
        if result.rowcount == 0:
            raise not_found("Coleção inexistente ou sem acesso.")
        await conn.execute(
            update(t.recordings)
            .where(r.collection_ids.contains([collection_id]))
            .values(
                collection_ids=func.array_remove(r.collection_ids, collection_id, type_=r.collection_ids.type),
                updated_at=datetime.now(UTC),
            )
        )
    return Response(status_code=204)


_TAGS = text(
    "SELECT tag AS name, count(*) AS count FROM recordings, unnest(recordings.tags) AS tag GROUP BY tag ORDER BY tag"
)


@router.get("/tags")
async def list_tags(principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Tags das gravações do usuário, com quantas gravações usam cada uma."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        rows = (await conn.execute(_TAGS)).mappings().all()
    return {"items": [{"name": row["name"], "count": row["count"]} for row in rows]}
