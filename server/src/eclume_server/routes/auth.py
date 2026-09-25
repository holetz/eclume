"""`health`, sessão (`auth/login`, `auth/logout`) e `me`."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, insert, select, update

from eclume_server import __version__, invitations
from eclume_server.accounts import MIN_PASSWORD
from eclume_server.auth import CSRF_COOKIE, SESSION_COOKIE, Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.problems import forbidden, invalid_field, unauthorized
from eclume_server.security import hash_password, needs_rehash, new_session_token, sha256_hex, verify_password
from eclume_server.serialize import user_json

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

CONTRACT_VERSION = "1.3.0"
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


class InvitationAccept(BaseModel):
    """Schema `InvitationAccept`."""

    name: str = Field(min_length=1)
    password: str = Field(min_length=MIN_PASSWORD)


@router.post("/auth/invitations/{invitation_token}/accept", status_code=204)
async def accept_invitation(invitation_token: str, body: InvitationAccept, ctx: Ctx) -> Response:
    """Cria a conta do convite e abre a sessão, como o login."""
    if not body.name.strip():
        raise invalid_field("name", "não pode ser vazio")
    now = datetime.now(UTC)
    async with system_tx(ctx.engine) as conn:
        user_id = await invitations.accept(conn, invitation_token, name=body.name, password=body.password)
        await conn.execute(update(t.users).where(t.users.c.id == user_id).values(last_login_at=now))
        return await _open_session(conn, ctx, user_id, now)


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
    """Usuário, organização, grupos e credencial correntes."""
    async with system_tx(ctx.engine) as conn:
        user = (await conn.execute(select(t.users).where(t.users.c.id == principal.user_id))).mappings().one()
        org = (
            (await conn.execute(select(t.organizations).where(t.organizations.c.id == principal.org_id)))
            .mappings()
            .one()
        )
        groups = (
            (
                await conn.execute(
                    select(t.groups.c.id, t.groups.c.name)
                    .join(t.group_members, t.group_members.c.group_id == t.groups.c.id)
                    .where(t.group_members.c.user_id == principal.user_id)
                    .order_by(t.groups.c.name)
                )
            )
            .mappings()
            .all()
        )
    return {
        "user": user_json(user),
        "organization": {"id": str(org["id"]), "name": org["name"]},
        "groups": [{"id": str(g["id"]), "name": g["name"]} for g in groups],
        "auth": {
            "method": principal.method,
            "scopes": list(principal.scopes),
            "token_id": str(principal.token_id) if principal.token_id else None,
        },
    }
