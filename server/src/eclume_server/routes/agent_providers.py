"""The platform's agent providers (`/admin/agent-providers`). Admin session only.

The API key goes in encrypted (`crypto.encrypt`) and never comes back: the response only says `api_key_set`.
Rules in docs/standards/code/server-agentes.md.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, StrictBool, StrictFloat, StrictInt, StrictStr
from sqlalchemy import delete, func, insert, select, text, tuple_, update
from sqlalchemy.ext.asyncio import AsyncConnection

from eclume_server.auth import Admin
from eclume_server.context import AppContext, get_ctx
from eclume_server.crypto import encrypt
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.pagination import Cursor, Limit, decode_cursor, iso, page
from eclume_server.problems import conflict, invalid_field, not_found
from eclume_server.serialize import Row
from eclume_server.settings_admin import BaseUrl
from eclume_server.summaries import PURPOSES

router = APIRouter(prefix="/admin")
Ctx = Annotated[AppContext, Depends(get_ctx)]
Kind = Literal["ollama", "openai-compatible", "anthropic", "claude-cli"]
OptionValue = StrictBool | StrictInt | StrictFloat | StrictStr
Purpose = Literal[PURPOSES]  # type: ignore[valid-type]
# Types that speak HTTP to a server the admin chose.
_NEEDS_BASE_URL = {"ollama", "openai-compatible"}


class AgentProviderCreate(BaseModel):
    """Schema `AgentProviderCreate`."""

    name: str = Field(min_length=1)
    kind: Kind
    base_url: BaseUrl = None
    model: str = Field(min_length=1)
    api_key: str | None = Field(default=None, min_length=1)
    enabled: bool = True
    options: dict[str, OptionValue] = Field(default_factory=dict)
    used_for: list[Purpose] | None = None


class AgentProviderPatch(BaseModel):
    """Schema `AgentProviderPatch`: `api_key: null` deletes the key; absent, keeps it."""

    name: str | None = Field(default=None, min_length=1)
    base_url: BaseUrl = None
    model: str | None = Field(default=None, min_length=1)
    api_key: str | None = None
    enabled: bool | None = None
    options: dict[str, OptionValue] | None = None
    used_for: list[Purpose] | None = None


def provider_json(row: Row) -> dict[str, Any]:
    """Schema `AgentProvider`."""
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "kind": row["kind"],
        "base_url": row["base_url"],
        "model": row["model"],
        "api_key_set": row["api_key_encrypted"] is not None,
        "enabled": row["enabled"],
        "options": dict(row["options"] or {}),
        "used_for": [purpose for purpose in PURPOSES if purpose in row["used_for"]],
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
    }


def _check_shape(kind: str, base_url: str | None) -> None:
    """Per-type invariants, at creation and after each edit."""
    if kind in _NEEDS_BASE_URL and not base_url:
        raise invalid_field("base_url", f"required for {kind}")
    if kind == "claude-cli" and base_url:
        raise invalid_field("base_url", "claude-cli does not use base_url")


async def _lock_purposes(conn: AsyncConnection) -> None:
    """Serializes the writes of `used_for` until the transaction ends (the lock of migration 013's trigger)."""
    await conn.execute(text("SELECT pg_advisory_xact_lock(hashtext('agent_providers.used_for'))"))


async def _claim(conn: AsyncConnection, provider_id: UUID | None, purposes: list[str]) -> None:
    """Takes from the other providers the purposes this one now declares: one per provider.

    At creation (`provider_id` null) it runs before the insert: the trigger refuses the overlap.
    """
    if purposes:
        await conn.execute(
            text(
                "UPDATE agent_providers"
                " SET used_for = ARRAY(SELECT unnest(used_for) EXCEPT SELECT unnest(CAST(:purposes AS text[]))),"
                " updated_at = now()"
                " WHERE id IS DISTINCT FROM CAST(:id AS uuid) AND used_for && CAST(:purposes AS text[])"
            ),
            {"id": provider_id, "purposes": purposes},
        )


async def _unclaimed(conn: AsyncConnection) -> list[str]:
    """Purposes no provider declares."""
    claimed = set((await conn.execute(select(func.unnest(t.agent_providers.c.used_for)))).scalars())
    return [purpose for purpose in PURPOSES if purpose not in claimed]


async def _get(conn: AsyncConnection, provider_id: UUID) -> Row:
    row = (
        (await conn.execute(select(t.agent_providers).where(t.agent_providers.c.id == provider_id))).mappings().first()
    )
    if row is None:
        raise not_found("Provider does not exist.")
    return row


@router.get("/agent-providers")
async def list_agent_providers(_: Admin, ctx: Ctx, cursor: Cursor = None, limit: Limit = 50) -> dict[str, Any]:
    """The platform's providers, in registration order."""
    c = t.agent_providers.c
    query = select(t.agent_providers).order_by(c.created_at, c.id).limit(limit + 1)
    if cursor:
        query = query.where(tuple_(c.created_at, c.id) > decode_cursor(cursor))
    async with system_tx(ctx.engine) as conn:
        rows = list((await conn.execute(query)).mappings().all())
    return page([provider_json(row) for row in rows], rows, limit, "created_at")


@router.post("/agent-providers", status_code=201)
async def create_agent_provider(body: AgentProviderCreate, _: Admin, ctx: Ctx) -> dict[str, Any]:
    """Registers a provider; without `used_for`, an enabled one takes the purposes nobody declares."""
    _check_shape(body.kind, body.base_url)
    values = body.model_dump(exclude={"api_key"})
    async with system_tx(ctx.engine) as conn:
        await _lock_purposes(conn)
        if values["used_for"] is None:
            values["used_for"] = await _unclaimed(conn) if body.enabled else []
        values["used_for"] = list(dict.fromkeys(values["used_for"]))
        await _claim(conn, None, values["used_for"])
        row = (
            (
                await conn.execute(
                    insert(t.agent_providers)
                    .values(
                        api_key_encrypted=encrypt(ctx.settings, body.api_key) if body.api_key else None,
                        key_set_at=func.now() if body.api_key else None,
                        **values,
                    )
                    .returning(t.agent_providers)
                )
            )
            .mappings()
            .one()
        )
    return provider_json(row)


@router.patch("/agent-providers/{provider_id}")
async def update_agent_provider(provider_id: UUID, body: AgentProviderPatch, _: Admin, ctx: Ctx) -> dict[str, Any]:
    """Edits the provider; `api_key: null` deletes the stored key; `used_for` takes the purposes from the others."""
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise invalid_field("body", "send at least one field")
    for field in ("name", "model", "enabled", "options", "used_for"):
        if field in values and values[field] is None:
            raise invalid_field(field, "cannot be null")
    if "api_key" in values:
        key = values.pop("api_key")
        if key == "":
            raise invalid_field("api_key", "cannot be empty")
        values["api_key_encrypted"] = encrypt(ctx.settings, key) if key is not None else None
        values["key_set_at"] = func.now() if key is not None else None
    if "used_for" in values:
        values["used_for"] = list(dict.fromkeys(values["used_for"]))
    async with system_tx(ctx.engine) as conn:
        await _lock_purposes(conn)
        current = await _get(conn, provider_id)
        merged = {**current, **values}
        _check_shape(merged["kind"], merged["base_url"])
        await _claim(conn, provider_id, values.get("used_for", []))
        row = (
            (
                await conn.execute(
                    update(t.agent_providers)
                    .where(t.agent_providers.c.id == provider_id)
                    .values(**values, updated_at=func.now())
                    .returning(t.agent_providers)
                )
            )
            .mappings()
            .one()
        )
    return provider_json(row)


@router.delete("/agent-providers/{provider_id}", status_code=204)
async def delete_agent_provider(provider_id: UUID, _: Admin, ctx: Ctx) -> Response:
    """Removes the provider; 409 with a summary queued or running on it. Its purposes are left without a provider."""
    async with system_tx(ctx.engine) as conn:
        await _get(conn, provider_id)
        # The open summaries belong to every user.
        busy = (
            await conn.execute(
                select(func.count())
                .select_from(t.summaries)
                .where(t.summaries.c.provider_id == provider_id, t.summaries.c.status.in_(["queued", "running"]))
            )
        ).scalar_one()
        if busy:
            raise conflict("There are summaries queued or running with this provider; wait for them to finish.")
        await conn.execute(delete(t.agent_providers).where(t.agent_providers.c.id == provider_id))
    return Response(status_code=204)
