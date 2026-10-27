"""Tokens: personal PATs (create) and device credentials; list and revoke both. Session only."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import insert, select, tuple_, update

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.pagination import Cursor, Limit, decode_cursor, iso, page
from eclume_server.problems import invalid_field, not_found
from eclume_server.security import new_pat, sha256_hex
from eclume_server.serialize import Row

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
SessionUser = Annotated[Principal, Depends(requires(session_only=True))]
Scope = Literal[
    "recordings:read",
    "recordings:write",
    "recordings:delete",
    "transcripts:read",
    "transcripts:write",
    "people:read",
    "people:write",
    "summaries:read",
    "summaries:write",
]
TokenKind = Literal["personal", "device"]


class TokenCreate(BaseModel):
    """Schema `TokenCreate`."""

    name: str = Field(min_length=1, max_length=100)
    scopes: list[Scope] = Field(min_length=1)
    expires_at: datetime | None = None


def token_json(row: Row) -> dict[str, Any]:
    """Schema `Token`."""
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "kind": row["kind"],
        "platform": row["platform"],
        "scopes": list(row["scopes"]),
        "prefix": row["prefix"],
        "created_at": iso(row["created_at"]),
        "last_used_at": iso(row["last_used_at"]),
        "expires_at": iso(row["expires_at"]),
        "revoked_at": iso(row["revoked_at"]),
    }


@router.get("/tokens")
async def list_tokens(
    principal: SessionUser, ctx: Ctx, cursor: Cursor = None, limit: Limit = 50, kind: TokenKind | None = None
) -> dict[str, Any]:
    """The user's tokens, revoked ones included, from the newest to the oldest."""
    query = select(t.api_tokens).order_by(t.api_tokens.c.created_at.desc(), t.api_tokens.c.id.desc()).limit(limit + 1)
    if kind:
        query = query.where(t.api_tokens.c.kind == kind)
    if cursor:
        position = decode_cursor(cursor)
        query = query.where(tuple_(t.api_tokens.c.created_at, t.api_tokens.c.id) < position)
    async with user_tx(ctx.engine, principal.user_id) as conn:
        rows = (await conn.execute(query)).mappings().all()
    return page([token_json(row) for row in rows], list(rows), limit, "created_at")


@router.post("/tokens", status_code=201)
async def create_token(body: TokenCreate, principal: SessionUser, ctx: Ctx) -> dict[str, Any]:
    """Create a PAT; the secret comes back only in this response."""
    if len(set(body.scopes)) != len(body.scopes):
        raise invalid_field("scopes", "escopos repetidos")
    if body.expires_at is not None and body.expires_at.tzinfo is None:
        raise invalid_field("expires_at", "informe o fuso (RFC 3339)")
    if body.expires_at is not None and body.expires_at <= datetime.now(UTC):
        raise invalid_field("expires_at", "deve estar no futuro")
    secret, prefix = new_pat()
    async with user_tx(ctx.engine, principal.user_id) as conn:
        row = (
            (
                await conn.execute(
                    insert(t.api_tokens)
                    .values(
                        user_id=principal.user_id,
                        name=body.name,
                        token_hash=sha256_hex(secret),
                        prefix=prefix,
                        scopes=list(body.scopes),
                        expires_at=body.expires_at,
                    )
                    .returning(t.api_tokens)
                )
            )
            .mappings()
            .one()
        )
    return {"token": token_json(row), "secret": secret}


@router.delete("/tokens/{token_id}", status_code=204)
async def revoke_token(token_id: UUID, principal: SessionUser, ctx: Ctx) -> Response:
    """Revoke one of the user's tokens (PAT or device); later uses get 401."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        found = (await conn.execute(select(t.api_tokens.c.id).where(t.api_tokens.c.id == token_id))).first()
        if found is None:
            raise not_found("PAT inexistente ou sem acesso.")
        await conn.execute(
            update(t.api_tokens)
            .where(t.api_tokens.c.id == token_id, t.api_tokens.c.revoked_at.is_(None))
            .values(revoked_at=datetime.now(UTC))
        )
    return Response(status_code=204)
