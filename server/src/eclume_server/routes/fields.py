"""Campos do usuário: listar, criar, obter, editar e excluir.

Título e tags são embutidos: não saem nem mudam de tipo. Os valores de cada gravação ficam em
`field_values`, com a origem (`auto`, `edited`, `accepted`).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy import delete, insert, select, tuple_, update

from eclume_server.agenda_types import next_position
from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.fields import FieldCreate, FieldPatch, check_options, field_json, free_key, get_field
from eclume_server.pagination import Cursor, Limit, decode_ordered_position, encode_position
from eclume_server.problems import conflict, invalid_field

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("recordings:read"))]
Writer = Annotated[Principal, Depends(requires("recordings:write"))]
_NOT_NULL = ("name", "kind", "options", "instructions", "auto_fill", "position")


@router.get("/fields")
async def list_fields(principal: Reader, ctx: Ctx, cursor: Cursor = None, limit: Limit = 50) -> dict[str, Any]:
    """Campos do usuário, na ordem da lista (os embutidos começam nela)."""
    c = t.fields.c
    query = select(t.fields).order_by(c.position, c.id).limit(limit + 1)
    if cursor:
        query = query.where(tuple_(c.position, c.id) > decode_ordered_position(cursor))
    async with user_tx(ctx.engine, principal.user_id) as conn:
        rows = (await conn.execute(query)).mappings().all()
    next_cursor = encode_position(rows[limit - 1]["position"], rows[limit - 1]["id"]) if len(rows) > limit else None
    return {"items": [field_json(row) for row in rows[:limit]], "next_cursor": next_cursor}


@router.post("/fields", status_code=201)
async def create_field(body: FieldCreate, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Cria um campo; a chave sai do nome e não muda depois."""
    values = body.model_dump()
    values["options"] = check_options(values["kind"], values["options"])
    async with user_tx(ctx.engine, principal.user_id) as conn:
        # Serializa as criações da conta: a chave livre é escolhida antes do INSERT.
        await conn.execute(select(t.users.c.id).where(t.users.c.id == principal.user_id).with_for_update())
        if values["position"] is None:
            values["position"] = await next_position(conn, t.fields)
        values["key"] = await free_key(conn, values["name"])
        row = (
            (await conn.execute(insert(t.fields).values(owner_id=principal.user_id, **values).returning(t.fields)))
            .mappings()
            .one()
        )
    return field_json(row)


@router.get("/fields/{field_id}")
async def get_field_route(field_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Um campo do usuário."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return field_json(await get_field(conn, field_id))


@router.patch("/fields/{field_id}")
async def update_field(field_id: UUID, body: FieldPatch, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Edita o campo; mudar o tipo descarta os valores já preenchidos (o formato muda)."""
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise invalid_field("body", "informe ao menos um campo")
    for name in _NOT_NULL:
        if name in values and values[name] is None:
            raise invalid_field(name, "não pode ser nulo")
    async with user_tx(ctx.engine, principal.user_id) as conn:
        current = await get_field(conn, field_id)
        kind = values.get("kind", current["kind"])
        kind_changed = kind != current["kind"]
        if kind_changed and current["builtin"]:
            raise invalid_field("kind", "um campo embutido não muda de tipo")
        if "options" in values or kind_changed:
            options = values.get("options", current["options"] if kind == "choice" else [])
            values["options"] = check_options(kind, options)
        if kind_changed:
            await conn.execute(delete(t.field_values).where(t.field_values.c.field_id == field_id))
        row = (
            (
                await conn.execute(
                    update(t.fields)
                    .where(t.fields.c.id == field_id)
                    .values(**values, updated_at=datetime.now(UTC))
                    .returning(t.fields)
                )
            )
            .mappings()
            .one()
        )
    return field_json(row)


@router.delete("/fields/{field_id}", status_code=204)
async def delete_field(field_id: UUID, principal: Writer, ctx: Ctx) -> Response:
    """Exclui o campo e os valores dele; os embutidos ficam (409 `builtin_field`)."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        current = await get_field(conn, field_id)
        if current["builtin"]:
            raise conflict("Título e tags são campos embutidos e não podem ser excluídos.", "builtin_field")
        await conn.execute(delete(t.fields).where(t.fields.c.id == field_id))
    return Response(status_code=204)
