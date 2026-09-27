"""Tipos de agenda do usuário: listar, criar, obter, editar e excluir.

A conta nasce com os tipos padrão da plataforma (`eclume_seed_user_defaults`) e os muda à vontade.
Excluir um tipo deixa sem tipo as gravações que o usavam; os resumos guardam nome e instruções.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy import delete, insert, select, tuple_, update
from sqlalchemy.exc import IntegrityError

from eclume_server.agenda_types import (
    AgendaTypeCreate,
    AgendaTypePatch,
    agenda_type_json,
    changes_of,
    create_values,
    get_agenda_type,
    next_position,
)
from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.pagination import Cursor, Limit, decode_ordered_position, encode_position
from eclume_server.problems import conflict, invalid_field, not_found

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("summaries:read"))]
Writer = Annotated[Principal, Depends(requires("summaries:write"))]
NAME_TAKEN = "Já existe um tipo de agenda com esse nome."


@router.get("/agenda-types")
async def list_agenda_types(principal: Reader, ctx: Ctx, cursor: Cursor = None, limit: Limit = 50) -> dict[str, Any]:
    """Tipos do usuário, na ordem da lista."""
    c = t.agenda_types.c
    query = select(t.agenda_types).order_by(c.position, c.id).limit(limit + 1)
    if cursor:
        query = query.where(tuple_(c.position, c.id) > decode_ordered_position(cursor))
    async with user_tx(ctx.engine, principal.user_id) as conn:
        rows = (await conn.execute(query)).mappings().all()
    next_cursor = encode_position(rows[limit - 1]["position"], rows[limit - 1]["id"]) if len(rows) > limit else None
    return {"items": [agenda_type_json(row) for row in rows[:limit]], "next_cursor": next_cursor}


@router.post("/agenda-types", status_code=201)
async def create_agenda_type(body: AgendaTypeCreate, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Cria um tipo; nome repetido entre os tipos do usuário é 409."""
    values = create_values(body)
    try:
        async with user_tx(ctx.engine, principal.user_id) as conn:
            if values["position"] is None:
                values["position"] = await next_position(conn, t.agenda_types)
            row = (
                (
                    await conn.execute(
                        insert(t.agenda_types).values(owner_id=principal.user_id, **values).returning(t.agenda_types)
                    )
                )
                .mappings()
                .one()
            )
    except IntegrityError as exc:
        raise conflict(NAME_TAKEN) from exc
    return agenda_type_json(row)


@router.get("/agenda-types/{agenda_type_id}")
async def get_agenda_type_route(agenda_type_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Um tipo do usuário."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return agenda_type_json(await get_agenda_type(conn, agenda_type_id))


@router.patch("/agenda-types/{agenda_type_id}")
async def update_agenda_type(
    agenda_type_id: UUID, body: AgendaTypePatch, principal: Writer, ctx: Ctx
) -> dict[str, Any]:
    """Edita o tipo; vale para as próximas detecções e resumos (os já feitos ficam como estão)."""
    values = changes_of(body)
    try:
        async with user_tx(ctx.engine, principal.user_id) as conn:
            await get_agenda_type(conn, agenda_type_id)
            row = (
                (
                    await conn.execute(
                        update(t.agenda_types)
                        .where(t.agenda_types.c.id == agenda_type_id)
                        .values(**values, updated_at=datetime.now(UTC))
                        .returning(t.agenda_types)
                    )
                )
                .mappings()
                .one()
            )
    except IntegrityError as exc:
        # O contrato não declara 409 no PATCH: nome repetido é um campo inválido.
        raise invalid_field("name", NAME_TAKEN) from exc
    return agenda_type_json(row)


@router.delete("/agenda-types/{agenda_type_id}", status_code=204)
async def delete_agenda_type(agenda_type_id: UUID, principal: Writer, ctx: Ctx) -> Response:
    """Exclui o tipo; as gravações que o usavam ficam sem tipo."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        result = await conn.execute(delete(t.agenda_types).where(t.agenda_types.c.id == agenda_type_id))
    if result.rowcount == 0:
        raise not_found("Tipo de agenda inexistente ou sem acesso.")
    return Response(status_code=204)
