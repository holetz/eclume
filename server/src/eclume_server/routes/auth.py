"""`health`, signup, session, password reset by link, `me` and the notice acceptance."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, insert, select, update

from eclume_server import __version__
from eclume_server.accounts import (
    MIN_PASSWORD,
    NOTICE_VERSION,
    AccountError,
    EmailTakenError,
    WrongPasswordError,
    change_password,
    confirm_password,
    create_user,
    new_password_hash,
    notice,
    password_login,
    password_reset_info,
    purge_user,
    reset_password,
)
from eclume_server.auth import CSRF_COOKIE, SESSION_COOKIE, Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.contract import CONTRACT_VERSION
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.health import readiness
from eclume_server.locale import parse_accept_language
from eclume_server.problems import ApiProblemError, conflict, forbidden, invalid_field, unauthorized
from eclume_server.quotas import usage
from eclume_server.ratelimit import (
    attempts,
    check_login,
    check_signups,
    client_ip,
    login_failed,
    login_succeeded,
    signup_created,
)
from eclume_server.recordings import open_jobs_of
from eclume_server.security import new_session_token, sha256_hex
from eclume_server.serialize import user_json

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

WRONG_PASSWORD = "Wrong e-mail or password."  # noqa: S105 — a message, not a password
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]


def check_email(value: str) -> str:
    """`format: email` validation for request bodies."""
    if not EMAIL_RE.match(value):
        msg = "invalid e-mail"
        raise ValueError(msg)
    return value


class LoginRequest(BaseModel):
    """Schema `LoginRequest`."""

    email: str
    password: str = Field(min_length=1, max_length=1024)

    _email = field_validator("email")(check_email)


class SignupRequest(BaseModel):
    """Schema `SignupRequest`."""

    name: str = Field(min_length=1)
    email: str
    password: str = Field(min_length=MIN_PASSWORD, max_length=1024)
    notice_version: str = Field(min_length=1)

    _email = field_validator("email")(check_email)


class NoticeAccept(BaseModel):
    """Schema `NoticeAccept`."""

    notice_version: str = Field(min_length=1)


def _check_notice(version: str) -> None:
    if version != NOTICE_VERSION:
        raise invalid_field("notice_version", f"accept the notice in force (version {NOTICE_VERSION})")


@router.get("/health")
async def health(ctx: Ctx) -> dict[str, str]:
    """Service health, contract version and, in a production image, the commit it was built from."""
    body = {"status": "ok", "version": __version__, "contract_version": CONTRACT_VERSION}
    if ctx.settings.commit:
        body["commit"] = ctx.settings.commit
    return body


@router.get("/health/ready")
async def health_ready(ctx: Ctx) -> JSONResponse:
    """Readiness: 200 when Postgres, Redis and storage answer within 2 s, 503 naming what is down."""
    body = await readiness(ctx)
    return JSONResponse(body, status_code=200 if body["status"] == "ok" else 503)


@router.post("/auth/login", status_code=204)
async def login(
    body: LoginRequest, request: Request, ctx: Ctx, _: Annotated[None, Depends(attempts("auth_login"))]
) -> Response:
    """Opens a session and sets `eclume_session` (HttpOnly) and `eclume_csrf` (readable)."""
    user_id = await user_password_login(ctx, body.email, body.password, client_ip(request))
    async with system_tx(ctx.engine) as conn:
        return await _open_session(conn, ctx, user_id, datetime.now(UTC))


async def user_password_login(ctx: AppContext, email: str, password: str, ip: str) -> UUID:
    """Password login of the user account under the failure limit; a wrong password is 401."""
    await check_login(ctx, "user", email, ip)
    user_id = await password_login(ctx.engine, email, password)
    if user_id is None:
        await login_failed(ctx, "user", email, ip)
        raise unauthorized(WRONG_PASSWORD)
    await login_succeeded(ctx, "user", email, ip)
    return user_id


@router.get("/auth/signup")
async def signup_info(ctx: Ctx) -> dict[str, Any]:
    """Whether signup is open, and the notice the new account accepts."""
    return {"open": ctx.settings.signup_open, "notice": notice()}


@router.post("/auth/signup", status_code=204)
async def signup(
    body: SignupRequest, request: Request, ctx: Ctx, _: Annotated[None, Depends(attempts("auth_signup"))]
) -> Response:
    """Creates the account with the notice acceptance and opens the session, like the login."""
    if not ctx.settings.signup_open:
        raise ApiProblemError(403, "signup_closed", "Signup is closed on this installation.")
    if not body.name.strip():
        raise invalid_field("name", "cannot be empty")
    _check_notice(body.notice_version)
    ip = client_ip(request)
    await check_signups(ctx, ip)
    password_hash = await new_password_hash(body.password)
    now = datetime.now(UTC)
    async with system_tx(ctx.engine) as conn:
        try:
            user_id = await create_user(
                conn,
                email=body.email,
                name=body.name.strip(),
                password_hash=password_hash,
                notice_version=body.notice_version,
            )
        except EmailTakenError as exc:
            raise conflict("An account with this e-mail already exists.", code="email_taken") from exc
        locale = parse_accept_language(request.headers.get("accept-language"))
        await conn.execute(update(t.users).where(t.users.c.id == user_id).values(last_login_at=now, locale=locale))
        response = await _open_session(conn, ctx, user_id, now)
    await signup_created(ctx, ip)
    return response


async def _open_session(conn: AsyncConnection, ctx: AppContext, user_id: UUID, now: datetime) -> Response:
    """Creates the session in the database and returns the 204 with the `eclume_session` and `eclume_csrf` cookies."""
    token, csrf = new_session_token(), new_session_token()
    ttl = timedelta(days=ctx.settings.session_ttl_days)
    await conn.execute(
        insert(t.sessions).values(token_hash=sha256_hex(token), csrf_token=csrf, user_id=user_id, expires_at=now + ttl)
    )
    response = Response(status_code=204)
    max_age = int(ttl.total_seconds())
    secure = ctx.settings.cookie_secure
    response.set_cookie(SESSION_COOKIE, token, max_age=max_age, httponly=True, secure=secure, samesite="lax")
    response.set_cookie(CSRF_COOKIE, csrf, max_age=max_age, httponly=False, secure=secure, samesite="lax")
    return response


class PasswordResetCheck(BaseModel):
    """Schema `PasswordResetCheck`."""

    token: str = Field(min_length=1, max_length=128)


class PasswordReset(BaseModel):
    """Schema `PasswordReset`."""

    token: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=1, max_length=1024)


def _invalid_reset_link() -> ApiProblemError:
    # Missing, expired and used give the same answer: the route is no oracle.
    return ApiProblemError(
        401,
        "invalid_reset_link",
        "This link expired or was already used. Ask the server's administrator for another one.",
        headers={"WWW-Authenticate": 'Bearer realm="eclume"'},
    )


ResetAttempts = Annotated[None, Depends(attempts("auth_password_reset"))]


@router.post("/auth/password-reset/check")
async def check_password_reset(body: PasswordResetCheck, ctx: Ctx, _: ResetAttempts) -> dict[str, Any]:
    """The e-mail and validity of a reset link, without consuming it."""
    info = await password_reset_info(ctx.engine, body.token)
    if info is None:
        raise _invalid_reset_link()
    return info


@router.post("/auth/password-reset", status_code=204)
async def reset_password_by_link(body: PasswordReset, ctx: Ctx, _: ResetAttempts) -> Response:
    """Changes the password through the link and ends every session of the account, without opening another."""
    try:
        reset = await reset_password(ctx.engine, body.token, body.new_password)
    except AccountError as exc:
        raise invalid_field("new_password", str(exc)) from exc
    if not reset:
        raise _invalid_reset_link()
    return Response(status_code=204)


@router.post("/auth/logout", status_code=204)
async def logout(
    principal: Annotated[Principal, Depends(requires(session_only=True, before_notice=True))], ctx: Ctx
) -> Response:
    """Ends the current session and removes the cookies."""
    if principal.session_id is None:
        raise forbidden("Logout requires a session.")
    async with system_tx(ctx.engine) as conn:
        await conn.execute(delete(t.sessions).where(t.sessions.c.id == principal.session_id))
    response = Response(status_code=204)
    _clear_cookies(response, ctx)
    return response


class PasswordChange(BaseModel):
    """Schema `PasswordChange`."""

    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=1, max_length=1024)
    revoke_tokens: bool = False


class AccountDeletion(BaseModel):
    """Schema `AccountDeletion`: the password confirms it is the owner."""

    password: str = Field(min_length=1, max_length=1024)


Member = Annotated[Principal, Depends(requires(session_only=True))]


def _clear_cookies(response: Response, ctx: AppContext) -> None:
    secure = ctx.settings.cookie_secure
    response.delete_cookie(SESSION_COOKIE, httponly=True, secure=secure, samesite="lax")
    response.delete_cookie(CSRF_COOKIE, secure=secure, samesite="lax")


@router.post("/me/password", status_code=204)
async def change_own_password(
    body: PasswordChange, principal: Member, ctx: Ctx, _: Annotated[None, Depends(attempts("me_password"))]
) -> Response:
    """Changes the password; the account's other sessions end and this one continues.

    With `revoke_tokens`, the account's device credentials and PATs are revoked too.
    """
    try:
        await confirm_password(ctx.engine, principal.user_id, body.current_password, "senha atual incorreta")
        await change_password(
            ctx.engine,
            principal.user_id,
            body.new_password,
            keep_session=principal.session_id,
            revoke_tokens=body.revoke_tokens,
        )
    except AccountError as exc:
        field = "current_password" if isinstance(exc, WrongPasswordError) else "new_password"
        raise invalid_field(field, str(exc)) from exc
    return Response(status_code=204)


@router.post("/me/delete", status_code=204)
async def delete_own_account(
    body: AccountDeletion, principal: Member, ctx: Ctx, _: Annotated[None, Depends(attempts("me_delete"))]
) -> Response:
    """Deletes the account and all its data; the objects leave the bucket through the deletion queue. Ends the session."""
    try:
        await confirm_password(ctx.engine, principal.user_id, body.password)
    except AccountError as exc:
        raise invalid_field("password", str(exc)) from exc
    async with system_tx(ctx.engine) as conn:
        open_jobs = await open_jobs_of(conn, principal.user_id)
        await purge_user(conn, principal.user_id)
    # The GPU stops transcribing what the deleted account had queued or running.
    await ctx.queue.request_cancel(open_jobs)
    response = Response(status_code=204)
    _clear_cookies(response, ctx)
    return response


@router.post("/me/notice", status_code=204)
async def accept_notice(
    body: NoticeAccept,
    principal: Annotated[Principal, Depends(requires(session_only=True, before_notice=True))],
    ctx: Ctx,
) -> Response:
    """Records the current account's acceptance of the notice in force."""
    _check_notice(body.notice_version)
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await conn.execute(
            update(t.users)
            .where(t.users.c.id == principal.user_id)
            .values(notice_version=body.notice_version, notice_accepted_at=func.now())
        )
    return Response(status_code=204)


@router.get("/me/usage")
async def my_usage(principal: Annotated[Principal, Depends(requires())], ctx: Ctx) -> dict[str, Any]:
    """Account usage and the effective quota (schema `Usage`)."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await usage(conn, ctx.queue.pool, principal.user_id)


@router.get("/me")
async def me(principal: Annotated[Principal, Depends(requires(before_notice=True))], ctx: Ctx) -> dict[str, Any]:
    """Current account and credential, and whether accepting the notice in force is still pending."""
    async with system_tx(ctx.engine) as conn:
        user = (await conn.execute(select(t.users).where(t.users.c.id == principal.user_id))).mappings().one()
    return {
        "user": user_json(user),
        "notice_required": user["notice_version"] != NOTICE_VERSION,
        "auth": {
            "method": principal.method,
            "scopes": list(principal.scopes),
            "token_id": str(principal.token_id) if principal.token_id else None,
        },
    }
