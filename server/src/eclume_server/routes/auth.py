"""`health`, cadastro (`auth/signup`), sessão (`auth/login`, `auth/logout`), `me` e o aceite do aviso."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, insert, select, update

from eclume_server import __version__
from eclume_server.accounts import MIN_PASSWORD, NOTICE_VERSION, EmailTakenError, create_user, notice
from eclume_server.auth import CSRF_COOKIE, SESSION_COOKIE, Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.problems import ApiProblemError, conflict, forbidden, invalid_field, unauthorized
from eclume_server.security import hash_password, needs_rehash, new_session_token, sha256_hex, verify_password
from eclume_server.serialize import user_json

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

CONTRACT_VERSION = "2.3.0"
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
        raise invalid_field("notice_version", f"aceite o aviso em vigor (versão {NOTICE_VERSION})")


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


@router.get("/auth/signup")
async def signup_info(ctx: Ctx) -> dict[str, Any]:
    """Se o cadastro está aberto, e o aviso que a conta nova aceita."""
    return {"open": ctx.settings.signup_open, "notice": notice()}


@router.post("/auth/signup", status_code=204)
async def signup(body: SignupRequest, ctx: Ctx) -> Response:
    """Cria a conta com o aceite do aviso e abre a sessão, como o login."""
    if not ctx.settings.signup_open:
        raise ApiProblemError(403, "signup_closed", "O cadastro está fechado nesta instalação.")
    if not body.name.strip():
        raise invalid_field("name", "não pode ser vazio")
    _check_notice(body.notice_version)
    now = datetime.now(UTC)
    async with system_tx(ctx.engine) as conn:
        try:
            user_id = await create_user(
                conn,
                email=body.email,
                name=body.name.strip(),
                password=body.password,
                notice_version=body.notice_version,
            )
        except EmailTakenError as exc:
            raise conflict("Já existe uma conta com este e-mail.", code="email_taken") from exc
        await conn.execute(update(t.users).where(t.users.c.id == user_id).values(last_login_at=now))
        return await _open_session(conn, ctx, user_id, now)


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
async def logout(
    principal: Annotated[Principal, Depends(requires(session_only=True, before_notice=True))], ctx: Ctx
) -> Response:
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


@router.post("/me/notice", status_code=204)
async def accept_notice(
    body: NoticeAccept,
    principal: Annotated[Principal, Depends(requires(session_only=True, before_notice=True))],
    ctx: Ctx,
) -> Response:
    """Registra o aceite do aviso em vigor pela conta corrente."""
    _check_notice(body.notice_version)
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await conn.execute(
            update(t.users)
            .where(t.users.c.id == principal.user_id)
            .values(notice_version=body.notice_version, notice_accepted_at=func.now())
        )
    return Response(status_code=204)


@router.get("/me")
async def me(principal: Annotated[Principal, Depends(requires(before_notice=True))], ctx: Ctx) -> dict[str, Any]:
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
