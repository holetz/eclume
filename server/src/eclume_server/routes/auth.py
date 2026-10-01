"""`health`, cadastro (`auth/signup`), sessão (`auth/login`, `auth/logout`), `me` e o aceite do aviso."""

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
    delete_user,
    new_password_hash,
    notice,
    password_login,
)
from eclume_server.auth import CSRF_COOKIE, SESSION_COOKIE, Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.health import readiness
from eclume_server.problems import ApiProblemError, conflict, forbidden, invalid_field, unauthorized
from eclume_server.quotas import usage
from eclume_server.ratelimit import attempts, check_login, client_ip, login_failed, login_succeeded
from eclume_server.recordings import open_jobs_of
from eclume_server.security import new_session_token, sha256_hex
from eclume_server.serialize import user_json

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

CONTRACT_VERSION = "2.14.0"
WRONG_PASSWORD = "E-mail ou senha incorretos."  # noqa: S105 — mensagem, não senha
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
async def health(ctx: Ctx) -> dict[str, str]:
    """Saúde do serviço, versão do contrato e, numa imagem de produção, o commit de que ela saiu."""
    body = {"status": "ok", "version": __version__, "contract_version": CONTRACT_VERSION}
    if ctx.settings.commit:
        body["commit"] = ctx.settings.commit
    return body


@router.get("/health/ready")
async def health_ready(ctx: Ctx) -> JSONResponse:
    """Prontidão: 200 quando Postgres, Redis e armazenamento respondem em 2 s, 503 nomeando o que caiu."""
    body = await readiness(ctx)
    return JSONResponse(body, status_code=200 if body["status"] == "ok" else 503)


@router.post("/auth/login", status_code=204)
async def login(
    body: LoginRequest, request: Request, ctx: Ctx, _: Annotated[None, Depends(attempts("auth_login"))]
) -> Response:
    """Abre sessão e define `eclume_session` (HttpOnly) e `eclume_csrf` (legível)."""
    user_id = await user_password_login(ctx, body.email, body.password, client_ip(request))
    async with system_tx(ctx.engine) as conn:
        return await _open_session(conn, ctx, user_id, datetime.now(UTC))


async def user_password_login(ctx: AppContext, email: str, password: str, ip: str) -> UUID:
    """Login por senha da conta de usuário sob o limite de falhas; senha errada é 401."""
    await check_login(ctx, "user", email, ip)
    user_id = await password_login(ctx.engine, email, password)
    if user_id is None:
        await login_failed(ctx, "user", email, ip)
        raise unauthorized(WRONG_PASSWORD)
    await login_succeeded(ctx, "user", email, ip)
    return user_id


@router.get("/auth/signup")
async def signup_info(ctx: Ctx) -> dict[str, Any]:
    """Se o cadastro está aberto, e o aviso que a conta nova aceita."""
    return {"open": ctx.settings.signup_open, "notice": notice()}


@router.post("/auth/signup", status_code=204)
async def signup(body: SignupRequest, ctx: Ctx, _: Annotated[None, Depends(attempts("auth_signup"))]) -> Response:
    """Cria a conta com o aceite do aviso e abre a sessão, como o login."""
    if not ctx.settings.signup_open:
        raise ApiProblemError(403, "signup_closed", "O cadastro está fechado nesta instalação.")
    if not body.name.strip():
        raise invalid_field("name", "não pode ser vazio")
    _check_notice(body.notice_version)
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
    _clear_cookies(response, ctx)
    return response


class PasswordChange(BaseModel):
    """Schema `PasswordChange`."""

    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=1, max_length=1024)
    revoke_tokens: bool = False


class AccountDeletion(BaseModel):
    """Schema `AccountDeletion`: a senha confirma que é o dono."""

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
    """Troca a senha; as outras sessões da conta acabam e esta continua.

    Com `revoke_tokens`, as credenciais de aparelho e os PATs da conta também são revogados.
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
    """Exclui a conta e todos os dados dela; os objetos saem do bucket pela fila de exclusão. Encerra a sessão."""
    try:
        await confirm_password(ctx.engine, principal.user_id, body.password)
    except AccountError as exc:
        raise invalid_field("password", str(exc)) from exc
    async with system_tx(ctx.engine) as conn:
        open_jobs = await open_jobs_of(conn, principal.user_id)
        await delete_user(conn, principal.user_id)
    # A GPU não segue transcrevendo o que a conta excluída tinha na fila ou em curso.
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
    """Registra o aceite do aviso em vigor pela conta corrente."""
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
    """Uso da conta e a cota efetiva (schema `Usage`)."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await usage(conn, ctx.queue.pool, principal.user_id)


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
