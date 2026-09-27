"""`health`, sessão (`auth/login`, `auth/logout`) e `me`."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, insert, select, update

from eclume_server import __version__
from eclume_server.accounts import NOTICE_VERSION
from eclume_server.auth import CSRF_COOKIE, SESSION_COOKIE, Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.problems import forbidden, unauthorized
from eclume_server.security import hash_password, needs_rehash, new_session_token, sha256_hex, verify_password
from eclume_server.serialize import user_json

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

CONTRACT_VERSION = "2.0.0"
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]


def check_email(value: str) -> str:
    """Validação de `format: email` para os corpos de requisição."""
    if not EMAIL_RE.match(value):
        msg = "e-mail inválido"
        raise ValueError(msg)
    return value


class LoginRequest(BaseModel):
    """Schema `LoginRequest`."""

    email: str
    password: str = Field(min_length=1)

    _email = field_validator("email")(check_email)


@router.get("/health")
async def health() -> dict[str, str]:
    """Saúde do serviço e versão do contrato."""
    return {"status": "ok", "version": __version__, "contract_version": CONTRACT_VERSION}


@router.post("/auth/login", status_code=204)
async def login(body: LoginRequest, ctx: Ctx) -> Response:
    """Abre sessão e define `eclume_session` (HttpOnly) e `eclume_csrf` (legível)."""
    now = datetime.now(UTC)
    async with system_tx(ctx.engine) as conn:
        query = select(t.users).where(func.lower(t.users.c.email) == body.email.lower())
        user = (await conn.execute(query)).mappings().first()
        if (
            not verify_password(user["password_hash"] if user else None, body.password)
            or not user
            or not user["active"]
        ):
            raise unauthorized("E-mail ou senha incorretos.")
        values: dict[str, Any] = {"last_login_at": now}
        if needs_rehash(user["password_hash"]):
            values["password_hash"] = hash_password(body.password)
        await conn.execute(update(t.users).where(t.users.c.id == user["id"]).values(**values))
        return await _open_session(conn, ctx, user["id"], now)


async def _open_session(conn: AsyncConnection, ctx: AppContext, user_id: UUID, now: datetime) -> Response:
    """Cria a sessão no banco e devolve o 204 com os cookies `eclume_session` e `eclume_csrf`."""
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


@router.post("/auth/logout", status_code=204)
async def logout(principal: Annotated[Principal, Depends(requires(session_only=True))], ctx: Ctx) -> Response:
    """Encerra a sessão corrente e remove os cookies."""
    if principal.session_id is None:
        raise forbidden("Logout exige sessão.")
    async with system_tx(ctx.engine) as conn:
        await conn.execute(delete(t.sessions).where(t.sessions.c.id == principal.session_id))
    response = Response(status_code=204)
    secure = ctx.settings.cookie_secure
    response.delete_cookie(SESSION_COOKIE, httponly=True, secure=secure, samesite="lax")
    response.delete_cookie(CSRF_COOKIE, secure=secure, samesite="lax")
    return response


@router.get("/me")
async def me(principal: Annotated[Principal, Depends(requires())], ctx: Ctx) -> dict[str, Any]:
    """Conta e credencial correntes, e se falta aceitar o aviso em vigor."""
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
