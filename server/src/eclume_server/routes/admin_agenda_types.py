"""The platform's default agenda types (`/admin/default-agenda-types`). Admin session only.

Those marked `include_for_new_users` are copied to every new account at sign-up
(`eclume_seed_user_defaults`); changing a default does not touch the copies accounts already have.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy import delete, insert, select, tuple_, update
from sqlalchemy.exc import IntegrityError

from eclume_server.agenda_types import (
    DefaultAgendaTypeCreate,
    DefaultAgendaTypePatch,
    changes_of,
    create_values,
    default_agenda_type_json,
    next_position,
)
from eclume_server.auth import Admin
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.pagination import Cursor, Limit, decode_ordered_position, encode_position
from eclume_server.problems import conflict, invalid_field, not_found

router = APIRouter(prefix="/admin")
Ctx = Annotated[AppContext, Depends(get_ctx)]
NAME_TAKEN = "A default agenda type with this name already exists."
MISSING = "Default agenda type does not exist."


@router.get("/default-agenda-types")
async def list_default_agenda_types(_: Admin, ctx: Ctx, cursor: Cursor = None, limit: Limit = 50) -> dict[str, Any]:
    """Default types, in list order."""
    c = t.default_agenda_types.c
    query = select(t.default_agenda_types).order_by(c.position, c.id).limit(limit + 1)
    if cursor:
        query = query.where(tuple_(c.position, c.id) > decode_ordered_position(cursor))
    async with system_tx(ctx.engine) as conn:
        rows = (await conn.execute(query)).mappings().all()
    next_cursor = encode_position(rows[limit - 1]["position"], rows[limit - 1]["id"]) if len(rows) > limit else None
    return {"items": [default_agenda_type_json(row) for row in rows[:limit]], "next_cursor": next_cursor}


@router.post("/default-agenda-types", status_code=201)
async def create_default_agenda_type(body: DefaultAgendaTypeCreate, _: Admin, ctx: Ctx) -> dict[str, Any]:
    """Create a default type; it applies to accounts created afterwards."""
    values = create_values(body)
    try:
        async with system_tx(ctx.engine) as conn:
            if values["position"] is None:
                values["position"] = await next_position(conn, t.default_agenda_types)
            row = (
                (await conn.execute(insert(t.default_agenda_types).values(**values).returning(t.default_agenda_types)))
                .mappings()
                .one()
            )
    except IntegrityError as exc:
        raise conflict(NAME_TAKEN) from exc
    return default_agenda_type_json(row)


@router.patch("/default-agenda-types/{agenda_type_id}")
async def update_default_agenda_type(
    agenda_type_id: UUID, body: DefaultAgendaTypePatch, _: Admin, ctx: Ctx
) -> dict[str, Any]:
    """Edit the default type; accounts that already copied it keep their copy."""
    values = changes_of(body)
    try:
        async with system_tx(ctx.engine) as conn:
            row = (
                (
                    await conn.execute(
                        update(t.default_agenda_types)
                        .where(t.default_agenda_types.c.id == agenda_type_id)
                        .values(**values, updated_at=datetime.now(UTC))
                        .returning(t.default_agenda_types)
                    )
                )
                .mappings()
                .first()
            )
    except IntegrityError as exc:
        raise invalid_field("name", NAME_TAKEN) from exc
    if row is None:
        raise not_found(MISSING)
    return default_agenda_type_json(row)


@router.delete("/default-agenda-types/{agenda_type_id}", status_code=204)
async def delete_default_agenda_type(agenda_type_id: UUID, _: Admin, ctx: Ctx) -> Response:
    """Delete the default type; the accounts' copies stay."""
    async with system_tx(ctx.engine) as conn:
        result = await conn.execute(delete(t.default_agenda_types).where(t.default_agenda_types.c.id == agenda_type_id))
    if result.rowcount == 0:
        raise not_found(MISSING)
    return Response(status_code=204)
