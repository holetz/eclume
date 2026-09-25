"""Credenciais: sessão por cookie (com CSRF) e PAT com escopos."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated
from uuid import UUID

from fastapi import Depends, Request
from sqlalchemy import select, update

from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.problems import forbidden, insufficient_scope, unauthorized
from eclume_server.security import PAT_PREFIX, sha256_hex

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

SESSION_COOKIE = "eclume_session"
CSRF_COOKIE = "eclume_csrf"
CSRF_HEADER = "X-CSRF-Token"
ALL_SCOPES = (
    "recordings:read",
    "recordings:write",
    "transcripts:read",
    "transcripts:write",
    "people:read",
    "people:write",
    "summaries:read",
    "summaries:write",
)
_MUTATING = {"POST", "PUT", "PATCH", "DELETE"}


@dataclass(frozen=True)
class Principal:
    """Quem faz a requisição e com que credencial."""

    user_id: UUID
    org_id: UUID
    role: str
    method: str  # session | pat
    scopes: tuple[str, ...]
    token_id: UUID | None = None
    session_id: UUID | None = None

    @property
    def is_admin(self) -> bool:
        """Papel `admin` na organização."""
        return self.role == "admin"


async def _from_pat(ctx: AppContext, secret: str) -> Principal:
    now = datetime.now(UTC)
    query = (
        select(t.api_tokens, t.users.c.role, t.users.c.active)
        .join(t.users, t.users.c.id == t.api_tokens.c.user_id)
        .where(t.api_tokens.c.token_hash == sha256_hex(secret))
    )
    async with system_tx(ctx.engine) as conn:
        row = (await conn.execute(query)).mappings().first()
        if (
            row is None
            or row["revoked_at"] is not None
            or (row["expires_at"] is not None and row["expires_at"] <= now)
            or not row["active"]
        ):
            raise unauthorized("PAT inválido, expirado ou revogado.")
        await conn.execute(update(t.api_tokens).where(t.api_tokens.c.id == row["id"]).values(last_used_at=now))
    scopes = tuple(scope for scope in ALL_SCOPES if scope in row["scopes"])
    return Principal(row["user_id"], row["org_id"], row["role"], "pat", scopes, token_id=row["id"])


async def _from_session(ctx: AppContext, token: str, request: Request) -> Principal:
    query = (
        select(
            t.sessions.c.id, t.sessions.c.csrf_token, t.users.c.id.label("user_id"), t.users.c.org_id, t.users.c.role
        )
        .join(t.users, t.users.c.id == t.sessions.c.user_id)
        .where(
            t.sessions.c.token_hash == sha256_hex(token),
            t.sessions.c.expires_at > datetime.now(UTC),
            t.users.c.active,
        )
    )
    async with system_tx(ctx.engine) as conn:
        row = (await conn.execute(query)).mappings().first()
    if row is None:
        raise unauthorized("Sessão inválida ou expirada.")
    if request.method in _MUTATING and request.headers.get(CSRF_HEADER) != row["csrf_token"]:
        # Sem o double-submit a sessão não é uma credencial completa: 401, que toda operação declara.
        raise unauthorized(f"O header {CSRF_HEADER} deve repetir o cookie {CSRF_COOKIE}.")
    return Principal(row["user_id"], row["org_id"], row["role"], "session", ALL_SCOPES, session_id=row["id"])


async def authenticate(request: Request, ctx: AppContext) -> Principal:
    """Resolve a credencial da requisição; um Bearer presente nunca cai para o cookie."""
    authorization = request.headers.get("Authorization")
    if authorization is not None:
        scheme, _, secret = authorization.partition(" ")
        secret = secret.strip()
        if scheme.lower() != "bearer" or not secret.startswith(PAT_PREFIX):
            raise unauthorized("Use Authorization: Bearer eclp_...")
        return await _from_pat(ctx, secret)
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        return await _from_session(ctx, token, request)
    raise unauthorized()


def requires(
    *scopes: str, session_only: bool = False, admin: bool = False
) -> Callable[[Request, AppContext], Awaitable[Principal]]:
    """Dependência que exige credencial, os escopos do PAT, sessão e/ou papel `admin`."""

    async def dependency(request: Request, ctx: Annotated[AppContext, Depends(get_ctx)]) -> Principal:
        principal = await authenticate(request, ctx)
        if principal.method == "pat":
            if session_only:
                # PAT não é credencial aceita aqui (o contrato declara só `sessionCookie`): 401.
                raise unauthorized("Esta operação aceita só sessão do navegador, não PAT.")
            missing = [scope for scope in scopes if scope not in principal.scopes]
            if missing:
                raise insufficient_scope(missing)
        if admin and not principal.is_admin:
            raise forbidden("Esta operação exige o papel admin.")
        return principal

    return dependency
