"""Grupos da organização: todo membro lê; só `admin` cria, edita e mexe nos membros. Só sessão."""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, insert, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.pagination import Cursor, Limit, decode_cursor, iso, page
from eclume_server.problems import conflict, invalid_field, not_found
from eclume_server.serialize import Row, user_ref

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Member = Annotated[Principal, Depends(requires(session_only=True))]
Admin = Annotated[Principal, Depends(requires(session_only=True, admin=True))]

_MEMBER_COUNT = (
    select(func.count())
    .select_from(t.group_members)
    .where(t.group_members.c.group_id == t.groups.c.id)
    .scalar_subquery()
    .label("member_count")
)


class GroupCreate(BaseModel):
    """Schema `GroupCreate`."""

    name: str = Field(min_length=1)
    description: str | None = None


class GroupPatch(BaseModel):
    """Schema `GroupPatch`."""

    name: str | None = Field(default=None, min_length=1)
    description: str | None = None


def group_json(row: Row, members: list[Row] | None = None) -> dict[str, Any]:
    """Schema `Group`; `members` só no detalhe."""
    body: dict[str, Any] = {
        "id": str(row["id"]),
        "name": row["name"],
        "description": row["description"],
        "member_count": row["member_count"],
        "created_at": iso(row["created_at"]),
    }
    if members is not None:
        body["members"] = [user_ref(m["id"], m["name"]) for m in members]
    return body


async def _get(conn: AsyncConnection, group_id: UUID) -> Any:  # noqa: ANN401
    row = (await conn.execute(select(t.groups, _MEMBER_COUNT).where(t.groups.c.id == group_id))).mappings().first()
    if row is None:
        raise not_found("Grupo inexistente.")
    return row


@router.get("/groups")
async def list_groups(principal: Member, ctx: Ctx, cursor: Cursor = None, limit: Limit = 50) -> dict[str, Any]:
    """Grupos da organização, do mais novo para o mais antigo."""
    query = (
        select(t.groups, _MEMBER_COUNT).order_by(t.groups.c.created_at.desc(), t.groups.c.id.desc()).limit(limit + 1)
    )
    if cursor:
        query = query.where(tuple_(t.groups.c.created_at, t.groups.c.id) < decode_cursor(cursor))
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        rows = (await conn.execute(query)).mappings().all()
    return page([group_json(row) for row in rows], list(rows), limit, "created_at")


@router.post("/groups", status_code=201)
async def create_group(body: GroupCreate, principal: Admin, ctx: Ctx) -> dict[str, Any]:
    """Cria um grupo; nome repetido na organização é 409."""
    try:
        async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
            group_id = (
                await conn.execute(
                    insert(t.groups)
                    .values(org_id=principal.org_id, name=body.name, description=body.description)
                    .returning(t.groups.c.id)
                )
            ).scalar_one()
            row = await _get(conn, group_id)
    except IntegrityError as exc:
        raise conflict("Já existe um grupo com este nome.") from exc
    return group_json(row)


@router.get("/groups/{group_id}")
async def get_group(group_id: UUID, principal: Member, ctx: Ctx) -> dict[str, Any]:
    """Um grupo e os seus membros."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        row = await _get(conn, group_id)
        members = (
            (
                await conn.execute(
                    select(t.users.c.id, t.users.c.name)
                    .join(t.group_members, t.group_members.c.user_id == t.users.c.id)
                    .where(t.group_members.c.group_id == group_id)
                    .order_by(t.users.c.name)
                )
            )
            .mappings()
            .all()
        )
    return group_json(row, list(members))


@router.patch("/groups/{group_id}")
async def update_group(group_id: UUID, body: GroupPatch, principal: Admin, ctx: Ctx) -> dict[str, Any]:
    """Edita nome e descrição."""
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise invalid_field("body", "informe ao menos um campo")
    if "name" in values and values["name"] is None:
        raise invalid_field("name", "não pode ser nulo")
    try:
        async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
            await _get(conn, group_id)
            await conn.execute(update(t.groups).where(t.groups.c.id == group_id).values(**values))
            row = await _get(conn, group_id)
    except IntegrityError as exc:
        raise conflict("Já existe um grupo com este nome.") from exc
    return group_json(row)


@router.delete("/groups/{group_id}", status_code=204)
async def delete_group(group_id: UUID, principal: Admin, ctx: Ctx) -> Response:
    """Exclui o grupo; os compartilhamentos com ele caem junto (FK em cascata)."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        result = await conn.execute(delete(t.groups).where(t.groups.c.id == group_id))
    if result.rowcount == 0:
        raise not_found("Grupo inexistente.")
    return Response(status_code=204)


async def _check_member_target(conn: AsyncConnection, group_id: UUID, user_id: UUID) -> None:
    await _get(conn, group_id)
    if (await conn.execute(select(t.users.c.id).where(t.users.c.id == user_id))).first() is None:
        raise not_found("Usuário inexistente.")


@router.put("/groups/{group_id}/members/{user_id}", status_code=204)
async def add_member(group_id: UUID, user_id: UUID, principal: Admin, ctx: Ctx) -> Response:
    """Põe o usuário no grupo (idempotente)."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        await _check_member_target(conn, group_id, user_id)
        await conn.execute(
            pg_insert(t.group_members)
            .values(group_id=group_id, user_id=user_id, org_id=principal.org_id)
            .on_conflict_do_nothing()
        )
    return Response(status_code=204)


@router.delete("/groups/{group_id}/members/{user_id}", status_code=204)
async def remove_member(group_id: UUID, user_id: UUID, principal: Admin, ctx: Ctx) -> Response:
    """Tira o usuário do grupo."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        await _check_member_target(conn, group_id, user_id)
        await conn.execute(
            delete(t.group_members).where(t.group_members.c.group_id == group_id, t.group_members.c.user_id == user_id)
        )
    return Response(status_code=204)
