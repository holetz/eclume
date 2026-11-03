"""Credentials: the user session by cookie (with CSRF), the PAT with scopes and the admin session.

The admin account is separate from user accounts: the admin session (`eclume_admin_session`) is the
only credential accepted on `/api/v1/admin/*`, and no user credential reaches the panel.
"""

from __future__ import annotations

import hmac
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Annotated
from uuid import UUID

from fastapi import Depends, Request
from sqlalchemy import select, update

from eclume_server.accounts import NOTICE_VERSION
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.problems import insufficient_scope, notice_required, session_required, unauthorized
from eclume_server.security import PAT_PREFIX, sha256_hex

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

SESSION_COOKIE = "eclume_session"
CSRF_COOKIE = "eclume_csrf"
ADMIN_SESSION_COOKIE = "eclume_admin_session"
ADMIN_CSRF_COOKIE = "eclume_admin_csrf"
# The admin session cookie only travels to the panel.
ADMIN_COOKIE_PATH = "/api/v1/admin"
CSRF_HEADER = "X-CSRF-Token"
ALL_SCOPES = (
    "recordings:read",
    "recordings:write",
    "recordings:delete",
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
    """Who makes the request and with which credential."""

    user_id: UUID
    method: str  # session | pat
    scopes: tuple[str, ...]
    token_id: UUID | None = None
    session_id: UUID | None = None
    # The account has not accepted the notice in force yet (only determined with a session).
    notice_pending: bool = False


@dataclass(frozen=True)
class AdminPrincipal:
    """The request's admin account, from the admin session."""

    admin_id: UUID
    session_id: UUID


# Precision of `api_tokens.last_used_at` and `mcp_last_used_at`.
USED_AT_RESOLUTION = timedelta(seconds=60)


async def _from_pat(ctx: AppContext, secret: str, *, via_mcp: bool = False) -> Principal:
    now = datetime.now(UTC)
    query = (
        select(t.api_tokens, t.users.c.active)
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
            raise unauthorized("Invalid, expired or revoked PAT.")
        # Use through MCP counts the connected assistants on the Health screen. Each mark is only
        # rewritten when the stored one is older than `USED_AT_RESOLUTION`: the PAT does not write to
        # the database on every request.
        stale = now - USED_AT_RESOLUTION
        used = {
            column: now
            for column in (("last_used_at", "mcp_last_used_at") if via_mcp else ("last_used_at",))
            if row[column] is None or row[column] < stale
        }
        if used:
            await conn.execute(update(t.api_tokens).where(t.api_tokens.c.id == row["id"]).values(**used))
    scopes = tuple(scope for scope in ALL_SCOPES if scope in row["scopes"])
    return Principal(row["user_id"], "pat", scopes, token_id=row["id"])


def _check_csrf(request: Request, expected: str, cookie: str) -> None:
    if request.method in _MUTATING and not hmac.compare_digest(request.headers.get(CSRF_HEADER, ""), expected):
        # Without the double-submit the session is not a complete credential: 401, which every operation declares.
        raise unauthorized(f"The {CSRF_HEADER} header must repeat the {cookie} cookie.")


async def _from_session(ctx: AppContext, token: str, request: Request) -> Principal:
    query = (
        select(t.sessions.c.id, t.sessions.c.csrf_token, t.users.c.id.label("user_id"), t.users.c.notice_version)
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
        raise unauthorized("Invalid or expired session.")
    _check_csrf(request, row["csrf_token"], CSRF_COOKIE)
    pending = row["notice_version"] != NOTICE_VERSION
    return Principal(row["user_id"], "session", ALL_SCOPES, session_id=row["id"], notice_pending=pending)


async def authenticate(request: Request, ctx: AppContext, *, bearer_only: bool = False) -> Principal:
    """Resolve the user credential; a Bearer that is present never falls back to the cookie.

    The admin session cookie is not a credential here: outside `/admin/*`, it is ignored. With
    `bearer_only` (the MCP server), only the Bearer counts, and the use is marked as MCP.
    """
    authorization = request.headers.get("Authorization")
    if authorization is not None:
        scheme, _, secret = authorization.partition(" ")
        secret = secret.strip()
        if scheme.lower() != "bearer" or not secret.startswith(PAT_PREFIX):
            raise unauthorized("Use Authorization: Bearer eclp_...")
        return await _from_pat(ctx, secret, via_mcp=bearer_only)
    if bearer_only:
        raise unauthorized("Use Authorization: Bearer eclp_...")
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        return await _from_session(ctx, token, request)
    raise unauthorized()


def requires(
    *scopes: str, session_only: bool = False, before_notice: bool = False
) -> Callable[[Request, AppContext], Awaitable[Principal]]:
    """Dependency that requires a user credential, the PAT's scopes and/or a session.

    The session of an account that has not accepted the notice in force only reaches the
    `before_notice` routes (`/me`, `/me/notice`, logout); the PAT is not blocked (desktop and lumea of
    migrated accounts).
    """

    async def dependency(request: Request, ctx: Annotated[AppContext, Depends(get_ctx)]) -> Principal:
        principal = await authenticate(request, ctx)
        if principal.notice_pending and not before_notice:
            raise notice_required()
        if principal.method == "pat":
            if session_only:
                # A valid credential, but not the one accepted here (the contract declares only `sessionCookie`).
                raise session_required()
            missing = [scope for scope in scopes if scope not in principal.scopes]
            if missing:
                raise insufficient_scope(missing)
        return principal

    return dependency


def requires_any(*scopes: str) -> Callable[[Request, AppContext], Awaitable[Principal]]:
    """Like `requires`, but one of the scopes is enough for the PAT (the contract lists one `pat` requirement per scope)."""
    authenticated = requires()

    async def dependency(request: Request, ctx: Annotated[AppContext, Depends(get_ctx)]) -> Principal:
        principal = await authenticated(request, ctx)
        if principal.method == "pat" and not any(scope in principal.scopes for scope in scopes):
            raise insufficient_scope(list(scopes), any_of=True)
        return principal

    return dependency


async def require_admin(request: Request, ctx: Annotated[AppContext, Depends(get_ctx)]) -> AdminPrincipal:
    """Dependency of the admin routes: only the admin session; a PAT or a user session is 401."""
    if request.headers.get("Authorization") is not None:
        raise unauthorized("The admin panel accepts only the admin session.")
    token = request.cookies.get(ADMIN_SESSION_COOKIE)
    if not token:
        raise unauthorized("Sign in with the admin account.")
    query = (
        select(t.admin_sessions.c.id, t.admin_sessions.c.csrf_token, t.admins.c.id.label("admin_id"))
        .join(t.admins, t.admins.c.id == t.admin_sessions.c.admin_id)
        .where(
            t.admin_sessions.c.token_hash == sha256_hex(token),
            t.admin_sessions.c.expires_at > datetime.now(UTC),
            t.admins.c.active,
        )
    )
    async with system_tx(ctx.engine) as conn:
        row = (await conn.execute(query)).mappings().first()
    if row is None:
        raise unauthorized("Invalid or expired admin session.")
    _check_csrf(request, row["csrf_token"], ADMIN_CSRF_COOKIE)
    return AdminPrincipal(row["admin_id"], row["id"])


Admin = Annotated[AdminPrincipal, Depends(require_admin)]
