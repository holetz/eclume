"""The admin account's session (`/admin/auth/login`, `/admin/auth/logout`, `/admin/me`).

The admin account is separate from user accounts: the same e-mail may exist in both, with their own
passwords and sessions. The session cookie travels only to `/api/v1/admin` (SameSite=Strict).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import delete, func, insert, select, update

from eclume_server.auth import ADMIN_COOKIE_PATH, ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE, Admin
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.pagination import iso
from eclume_server.problems import unauthorized
from eclume_server.ratelimit import attempts, check_login, client_ip, login_failed, login_succeeded
from eclume_server.routes.auth import LoginRequest
from eclume_server.security import (
    hash_password_async,
    needs_rehash,
    new_session_token,
    sha256_hex,
    verify_password_async,
)

router = APIRouter(prefix="/admin")
Ctx = Annotated[AppContext, Depends(get_ctx)]


@router.post("/auth/login", status_code=204)
async def admin_login(
    body: LoginRequest, request: Request, ctx: Ctx, _: Annotated[None, Depends(attempts("admin_login"))]
) -> Response:
    """Open the admin session: `eclume_admin_session` (HttpOnly, panel only) and `eclume_admin_csrf`."""
    ip = client_ip(request)
    await check_login(ctx, "admin", body.email, ip)
    now = datetime.now(UTC)
    async with system_tx(ctx.engine) as conn:
        query = select(t.admins).where(func.lower(t.admins.c.email) == body.email.lower())
        admin = (await conn.execute(query)).mappings().first()
    # argon2 runs in a thread and outside the transaction.
    if (
        not await verify_password_async(admin["password_hash"] if admin else None, body.password)
        or not admin
        or not admin["active"]
    ):
        await login_failed(ctx, "admin", body.email, ip)
        raise unauthorized("Wrong e-mail or password.")
    await login_succeeded(ctx, "admin", body.email, ip)
    values: dict[str, Any] = {"last_login_at": now}
    if needs_rehash(admin["password_hash"]):
        values["password_hash"] = await hash_password_async(body.password)
    async with system_tx(ctx.engine) as conn:
        await conn.execute(update(t.admins).where(t.admins.c.id == admin["id"]).values(**values))
        token, csrf = new_session_token(), new_session_token()
        ttl = timedelta(hours=ctx.settings.admin_session_ttl_hours)
        await conn.execute(
            insert(t.admin_sessions).values(
                token_hash=sha256_hex(token), csrf_token=csrf, admin_id=admin["id"], expires_at=now + ttl
            )
        )
    response = Response(status_code=204)
    max_age = int(ttl.total_seconds())
    secure = ctx.settings.cookie_secure
    response.set_cookie(
        ADMIN_SESSION_COOKIE,
        token,
        max_age=max_age,
        path=ADMIN_COOKIE_PATH,
        httponly=True,
        secure=secure,
        samesite="strict",
    )
    response.set_cookie(ADMIN_CSRF_COOKIE, csrf, max_age=max_age, httponly=False, secure=secure, samesite="strict")
    return response


@router.post("/auth/logout", status_code=204)
async def admin_logout(admin: Admin, ctx: Ctx) -> Response:
    """End the admin session and remove the cookies."""
    async with system_tx(ctx.engine) as conn:
        await conn.execute(delete(t.admin_sessions).where(t.admin_sessions.c.id == admin.session_id))
    response = Response(status_code=204)
    secure = ctx.settings.cookie_secure
    response.delete_cookie(
        ADMIN_SESSION_COOKIE, path=ADMIN_COOKIE_PATH, httponly=True, secure=secure, samesite="strict"
    )
    response.delete_cookie(ADMIN_CSRF_COOKIE, secure=secure, samesite="strict")
    return response


@router.get("/me")
async def admin_me(admin: Admin, ctx: Ctx) -> dict[str, Any]:
    """Schema `AdminAccount` of the current admin account."""
    async with system_tx(ctx.engine) as conn:
        row = (await conn.execute(select(t.admins).where(t.admins.c.id == admin.admin_id))).mappings().one()
    return {
        "id": str(row["id"]),
        "email": row["email"],
        "name": row["name"],
        "created_at": iso(row["created_at"]),
        "last_login_at": iso(row["last_login_at"]),
    }
