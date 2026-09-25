"""Providers de agente de sumarização (`/admin/agent-providers`). Só sessão de `admin`.

A chave de API entra cifrada (`crypto.encrypt`) e nunca volta: a resposta diz só `api_key_set`.
O painel de configuração e os segredos da organização são da #12; estas rotas existem aqui porque
o job de resumo não roda sem provider cadastrado (docs/standards/code/server-agentes.md).
"""

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, StrictBool, StrictFloat, StrictInt, StrictStr
from sqlalchemy import delete, func, insert, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncConnection

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.crypto import encrypt
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.pagination import Cursor, Limit, decode_cursor, iso, page
from eclume_server.problems import conflict, invalid_field, not_found
from eclume_server.serialize import Row
from eclume_server.settings_admin import BaseUrl
from eclume_server.summaries import get_summarization, set_summarization

router = APIRouter(prefix="/admin")
Ctx = Annotated[AppContext, Depends(get_ctx)]
Admin = Annotated[Principal, Depends(requires(session_only=True, admin=True))]
Kind = Literal["ollama", "openai-compatible", "anthropic", "claude-cli"]
OptionValue = StrictBool | StrictInt | StrictFloat | StrictStr
# Tipos que falam HTTP com um servidor escolhido pelo admin.
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


class AgentProviderPatch(BaseModel):
    """Schema `AgentProviderPatch`: `api_key: null` apaga a chave; ausente, mantém."""

    name: str | None = Field(default=None, min_length=1)
    base_url: BaseUrl = None
    model: str | None = Field(default=None, min_length=1)
    api_key: str | None = None
    enabled: bool | None = None
    options: dict[str, OptionValue] | None = None


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
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
    }


def _check_shape(kind: str, base_url: str | None) -> None:
    """Invariantes por tipo, na criação e depois de cada edição."""
    if kind in _NEEDS_BASE_URL and not base_url:
        raise invalid_field("base_url", f"obrigatória para {kind}")
    if kind == "claude-cli" and base_url:
        raise invalid_field("base_url", "o claude-cli não usa base_url")


async def _get(conn: AsyncConnection, provider_id: UUID) -> Row:
    row = (
        (await conn.execute(select(t.agent_providers).where(t.agent_providers.c.id == provider_id))).mappings().first()
    )
    if row is None:
        raise not_found("Provider inexistente.")
    return row


@router.get("/agent-providers")
async def list_agent_providers(principal: Admin, ctx: Ctx, cursor: Cursor = None, limit: Limit = 50) -> dict[str, Any]:
    """Providers da organização, na ordem de cadastro."""
    c = t.agent_providers.c
    query = select(t.agent_providers).order_by(c.created_at, c.id).limit(limit + 1)
    if cursor:
        query = query.where(tuple_(c.created_at, c.id) > decode_cursor(cursor))
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        rows = list((await conn.execute(query)).mappings().all())
    return page([provider_json(row) for row in rows], rows, limit, "created_at")


@router.post("/agent-providers", status_code=201)
async def create_agent_provider(body: AgentProviderCreate, principal: Admin, ctx: Ctx) -> dict[str, Any]:
    """Cadastra um provider; o primeiro habilitado de uma organização sem padrão vira o padrão."""
    _check_shape(body.kind, body.base_url)
    values = body.model_dump(exclude={"api_key"})
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        row = (
            (
                await conn.execute(
                    insert(t.agent_providers)
                    .values(
                        org_id=principal.org_id,
                        api_key_encrypted=encrypt(ctx.settings, body.api_key) if body.api_key else None,
                        **values,
                    )
                    .returning(t.agent_providers)
                )
            )
            .mappings()
            .one()
        )
        summarization = await get_summarization(conn, principal.org_id)
        if body.enabled and summarization.get("default_provider_id") is None:
            await set_summarization(conn, principal.org_id, principal.user_id, default_provider_id=str(row["id"]))
    return provider_json(row)


@router.patch("/agent-providers/{provider_id}")
async def update_agent_provider(
    provider_id: UUID, body: AgentProviderPatch, principal: Admin, ctx: Ctx
) -> dict[str, Any]:
    """Edita o provider; `api_key: null` apaga a chave guardada."""
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise invalid_field("body", "informe ao menos um campo")
    for field in ("name", "model", "enabled", "options"):
        if field in values and values[field] is None:
            raise invalid_field(field, "não pode ser nulo")
    if "api_key" in values:
        key = values.pop("api_key")
        if key == "":
            raise invalid_field("api_key", "não pode ser vazia")
        values["api_key_encrypted"] = encrypt(ctx.settings, key) if key is not None else None
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        current = await _get(conn, provider_id)
        merged = {**current, **values}
        _check_shape(merged["kind"], merged["base_url"])
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
async def delete_agent_provider(provider_id: UUID, principal: Admin, ctx: Ctx) -> Response:
    """Remove o provider; 409 com resumo na fila ou rodando nele. Sendo o padrão, deixa de haver padrão."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        await _get(conn, provider_id)
        # Os resumos em aberto são de toda a organização, inclusive de gravações que o admin não vê.
        async with system_tx(ctx.engine) as system:
            busy = (
                await system.execute(
                    select(func.count())
                    .select_from(t.summaries)
                    .where(
                        t.summaries.c.org_id == principal.org_id,
                        t.summaries.c.provider_id == provider_id,
                        t.summaries.c.status.in_(["queued", "running"]),
                    )
                )
            ).scalar_one()
        if busy:
            raise conflict("Há resumos na fila ou rodando com este provider; espere terminarem.")
        await conn.execute(delete(t.agent_providers).where(t.agent_providers.c.id == provider_id))
        summarization = await get_summarization(conn, principal.org_id)
        if summarization.get("default_provider_id") == str(provider_id):
            await set_summarization(conn, principal.org_id, principal.user_id, default_provider_id=None)
    return Response(status_code=204)
