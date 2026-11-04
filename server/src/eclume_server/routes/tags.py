"""The user's tag registry and the automatic tag configuration.

Tags are fixed by default: the agent only chooses among the registered ones. Renaming, merging and
deleting also change the recordings and the agenda types' default tags. Contract in
docs/standards/code/processamento-automatico.md.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import any_, delete, func, insert, select, update
from sqlalchemy.exc import IntegrityError

from eclume_server.agents.extraction import MAX_INSTRUCTIONS, MAX_TAG
from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.fields import builtin_fields
from eclume_server.pagination import iso
from eclume_server.problems import conflict, invalid_field, not_found
from eclume_server.tags import MAX_CATALOG, MAX_NEW_LIMIT, replace_everywhere

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("recordings:read"))]
Writer = Annotated[Principal, Depends(requires("recordings:write"))]
Member = Annotated[Principal, Depends(requires(session_only=True))]
TAG_TAKEN = "A tag with this name already exists. To join the two, use Merge."

_count = (
    select(func.count())
    .select_from(t.recordings)
    .where(t.tags.c.name == any_(t.recordings.c.tags))
    .scalar_subquery()
    .label("count")
)


class TagCreate(BaseModel):
    """Schema `TagCreate`."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=MAX_TAG)
    description: str = Field(default="", max_length=MAX_INSTRUCTIONS)


class TagPatch(BaseModel):
    """Schema `TagPatch`."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=MAX_TAG)
    description: str | None = Field(default=None, max_length=MAX_INSTRUCTIONS)


class TagMerge(BaseModel):
    """Schema `TagMerge`: the tag that stays."""

    model_config = ConfigDict(extra="forbid")

    into: UUID


class TagAssignmentPatch(BaseModel):
    """Body of `PATCH /me/tag-assignment`: the fields sent change, the others stay."""

    model_config = ConfigDict(extra="forbid")

    auto_fill: bool | None = None
    instructions: str | None = Field(default=None, max_length=MAX_INSTRUCTIONS)
    mode: Literal["fixed", "auto"] | None = None
    new_limit: int | None = Field(default=None, ge=1, le=MAX_NEW_LIMIT)


def tag_json(row: Row) -> dict[str, Any]:
    """Schema `Tag`."""
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "description": row["description"],
        "origin": row["origin"],
        "count": row["count"],
        "created_at": iso(row["created_at"]),
    }


async def _get(conn: AsyncConnection, tag_id: UUID) -> Row:
    row = (await conn.execute(select(t.tags, _count).where(t.tags.c.id == tag_id))).mappings().first()
    if row is None:
        raise not_found("Tag does not exist or is not accessible.")
    return row


@router.get("/tags")
async def list_tags(principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """The user's tag registry, with how many recordings use each one, in alphabetical order."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        rows = (
            (await conn.execute(select(t.tags, _count).order_by(func.lower(t.tags.c.name), t.tags.c.id)))
            .mappings()
            .all()
        )
    return {"items": [tag_json(row) for row in rows]}


@router.post("/tags", status_code=201)
async def create_tag(body: TagCreate, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Registers a tag; the same name (ignoring accents and case) is 409."""
    name = body.name.strip()
    if not name:
        raise invalid_field("name", "cannot be empty")
    try:
        async with user_tx(ctx.engine, principal.user_id) as conn:
            tag_id = (
                await conn.execute(
                    insert(t.tags)
                    .values(owner_id=principal.user_id, name=name, description=body.description.strip())
                    .returning(t.tags.c.id)
                )
            ).scalar_one()
            return tag_json(await _get(conn, tag_id))
    except IntegrityError as exc:
        raise conflict(TAG_TAKEN, "tag_exists") from exc


@router.patch("/tags/{tag_id}")
async def update_tag(tag_id: UUID, body: TagPatch, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Renames (in recordings and types too) or describes the tag; a name already in use is 409."""
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise invalid_field("body", "send at least one field")
    if any(value is None for value in values.values()):
        raise invalid_field("body", "the fields do not accept null")
    values = {key: value.strip() for key, value in values.items()}
    if values.get("name") == "":
        raise invalid_field("name", "cannot be empty")
    try:
        async with user_tx(ctx.engine, principal.user_id) as conn:
            current = await _get(conn, tag_id)
            await conn.execute(
                update(t.tags).where(t.tags.c.id == tag_id).values(**values, updated_at=datetime.now(UTC))
            )
            if "name" in values and values["name"] != current["name"]:
                await replace_everywhere(conn, current["name"], values["name"])
            return tag_json(await _get(conn, tag_id))
    except IntegrityError as exc:
        raise conflict(TAG_TAKEN, "tag_exists") from exc


@router.post("/tags/{tag_id}/merge")
async def merge_tag(tag_id: UUID, body: TagMerge, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Merges the tag into another: wherever it was, `into` stays (without repeating), and it leaves the registry."""
    if body.into == tag_id:
        raise invalid_field("into", "choose another tag")
    async with user_tx(ctx.engine, principal.user_id) as conn:
        source = await _get(conn, tag_id)
        target = (await conn.execute(select(t.tags).where(t.tags.c.id == body.into))).mappings().first()
        if target is None:
            raise invalid_field("into", "tag does not exist")
        await replace_everywhere(conn, source["name"], target["name"])
        await conn.execute(delete(t.tags).where(t.tags.c.id == tag_id))
        return tag_json(await _get(conn, body.into))


@router.delete("/tags/{tag_id}", status_code=204)
async def delete_tag(tag_id: UUID, principal: Writer, ctx: Ctx) -> Response:
    """Deletes the tag from the registry, from the recordings and from the types' default tags."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        current = await _get(conn, tag_id)
        await replace_everywhere(conn, current["name"], None)
        await conn.execute(delete(t.tags).where(t.tags.c.id == tag_id))
    return Response(status_code=204)


# --- automatic tag configuration -----------------------------------------------------------------


async def _assignment(conn: AsyncConnection, user_id: UUID) -> dict[str, Any]:
    """Schema `TagAssignment`: the automatic switch and the rule of the built-in Tags, the mode and the limit."""
    field = (await builtin_fields(conn, user_id))["tags"]
    mode, limit = (
        await conn.execute(select(t.users.c.tag_mode, t.users.c.tag_new_limit).where(t.users.c.id == user_id))
    ).one()
    total = (await conn.execute(select(func.count()).select_from(t.tags))).scalar_one()
    return {
        "auto_fill": field["auto_fill"],
        "instructions": field["instructions"],
        "mode": mode,
        # In fixed mode the limit is kept for when self-managed mode comes back.
        "new_limit": max(limit, 1),
        "catalog_count": total,
        "catalog_limit": MAX_CATALOG,
    }


@router.get("/me/tag-assignment")
async def get_tag_assignment(principal: Member, ctx: Ctx) -> dict[str, Any]:
    """How the agent assigns tags: on or off, the general rule, the mode and the limit of new tags."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await _assignment(conn, principal.user_id)


@router.patch("/me/tag-assignment")
async def patch_tag_assignment(body: TagAssignmentPatch, principal: Member, ctx: Ctx) -> dict[str, Any]:
    """Changes the configuration; it applies to the next transcriptions."""
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise invalid_field("body", "send at least one field")
    if any(value is None for value in values.values()):
        raise invalid_field("body", "the fields do not accept null")
    async with user_tx(ctx.engine, principal.user_id) as conn:
        field = (await builtin_fields(conn, principal.user_id))["tags"]
        own = {key: values[key] for key in ("auto_fill", "instructions") if key in values}
        if own:
            await conn.execute(
                update(t.fields).where(t.fields.c.id == field["id"]).values(**own, updated_at=datetime.now(UTC))
            )
        user = {
            column: values[key]
            for key, column in (("mode", "tag_mode"), ("new_limit", "tag_new_limit"))
            if key in values
        }
        if user:
            await conn.execute(update(t.users).where(t.users.c.id == principal.user_id).values(**user))
        return await _assignment(conn, principal.user_id)
