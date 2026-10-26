"""Coleções do usuário, com a regra que o agente segue para incluir gravações."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import any_, case, delete, func, insert, select, tuple_, update
from sqlalchemy.dialects.postgresql import array

from eclume_server.agents.extraction import MAX_INSTRUCTIONS
from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.input_limits import MAX_COLLECTION_DESCRIPTION, MAX_COLLECTION_NAME
from eclume_server.pagination import Cursor, Limit, decode_named_position, encode_position, iso
from eclume_server.problems import ApiProblemError, invalid_field, not_found

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

    name: str = Field(min_length=1, max_length=MAX_COLLECTION_NAME)
    description: str | None = Field(default=None, max_length=MAX_COLLECTION_DESCRIPTION)
    instructions: str = Field(default="", max_length=MAX_INSTRUCTIONS)
    auto_assign: bool = False


class CollectionPatch(BaseModel):
    """Schema `CollectionPatch`."""

    name: str | None = Field(default=None, min_length=1, max_length=MAX_COLLECTION_NAME)
    description: str | None = Field(default=None, max_length=MAX_COLLECTION_DESCRIPTION)
    instructions: str | None = Field(default=None, max_length=MAX_INSTRUCTIONS)
    auto_assign: bool | None = None


class CollectionMerge(BaseModel):
    """Schema `CollectionMerge`: a coleção que recebe as gravações."""

    into: UUID


def _select() -> Select:
    """Coleções do usuário (a RLS só mostra as dele) com as gravações que as usam."""
    return select(t.collections, _sort_name, _recording_count)


def collection_json(row: Row) -> dict[str, Any]:
    """Schema `Collection`."""
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "description": row["description"],
        "instructions": row["instructions"],
        "auto_assign": row["auto_assign"],
        "recording_count": row["recording_count"],
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
    }


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
    for field in ("name", "instructions", "auto_assign"):
        if field in values and values[field] is None:
            raise invalid_field(field, "não pode ser nulo")
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await _get(conn, collection_id)
        await conn.execute(
            update(t.collections)
            .where(t.collections.c.id == collection_id)
            .values(**values, updated_at=datetime.now(UTC))
        )
        if "name" in values:
            # O nome é a subpasta da pasta sincronizada do desktop: as gravações da coleção
            # reaparecem no `?since=` e mudam de pasta.
            r = t.recordings.c
            await conn.execute(
                update(t.recordings)
                .where(r.collection_ids.contains([collection_id]))
                .values(updated_at=datetime.now(UTC))
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


@router.post("/collections/{collection_id}/merge")
async def merge_collection(collection_id: UUID, body: CollectionMerge, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Junta a coleção a outra: as gravações dela passam para `into`, sem repetição, e ela é excluída.

    A coleção que recebe fica com o nome, a descrição e a regra dela.
    """
    if body.into == collection_id:
        raise invalid_field("into", "escolha outra coleção")
    r = t.recordings.c
    now = datetime.now(UTC)
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await _get(conn, collection_id)
        try:
            await _get(conn, body.into)
        except ApiProblemError as exc:
            raise invalid_field("into", "coleção inexistente") from exc
        without = func.array_remove(r.collection_ids, collection_id, type_=r.collection_ids.type)
        moved = (
            (
                await conn.execute(
                    update(t.recordings)
                    .where(r.collection_ids.contains([collection_id]))
                    .values(
                        collection_ids=case(
                            (r.collection_ids.contains([body.into]), without),
                            else_=without.concat(array([body.into])),
                        ),
                        updated_at=now,
                    )
                    .returning(r.id)
                )
            )
            .scalars()
            .all()
        )
        if moved:
            # As coleções são pastas do desktop: as transcrições reaparecem no `?since=`.
            await conn.execute(
                update(t.transcripts).where(t.transcripts.c.recording_id.in_(moved)).values(updated_at=now)
            )
        await conn.execute(delete(t.collections).where(t.collections.c.id == collection_id))
        return collection_json(await _get(conn, body.into))
