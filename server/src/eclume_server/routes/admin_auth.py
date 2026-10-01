"""Sessão da conta de admin (`/admin/auth/login`, `/admin/auth/logout`, `/admin/me`).

A conta de admin é separada das contas de usuário: o mesmo e-mail pode existir nas duas, com
senhas e sessões próprias. O cookie da sessão só viaja para `/api/v1/admin` (SameSite=Strict).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response
from sqlalchemy import delete, func, insert, select, update

from eclume_server.auth import ADMIN_COOKIE_PATH, ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE, Admin
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.pagination import iso
from eclume_server.problems import unauthorized
from eclume_server.ratelimit import attempts, count_login
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
async def admin_login(body: LoginRequest, ctx: Ctx, _: Annotated[None, Depends(attempts("admin_login"))]) -> Response:
    """Abre a sessão de admin: `eclume_admin_session` (HttpOnly, só no painel) e `eclume_admin_csrf`."""
    await count_login(ctx, "admin", body.email)
    now = datetime.now(UTC)
    async with system_tx(ctx.engine) as conn:
        query = select(t.admins).where(func.lower(t.admins.c.email) == body.email.lower())
        admin = (await conn.execute(query)).mappings().first()
    # O argon2 roda numa thread e fora da transação.
    if (
        not await verify_password_async(admin["password_hash"] if admin else None, body.password)
        or not admin
        or not admin["active"]
    ):
        raise unauthorized("E-mail ou senha incorretos.")
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
    """Encerra a sessão de admin e remove os cookies."""
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
    """Schema `AdminAccount` da conta de admin corrente."""
    async with system_tx(ctx.engine) as conn:
        row = (await conn.execute(select(t.admins).where(t.admins.c.id == admin.admin_id))).mappings().one()
    return {
        "id": str(row["id"]),
        "email": row["email"],
        "name": row["name"],
        "created_at": iso(row["created_at"]),
        "last_login_at": iso(row["last_login_at"]),
    }
