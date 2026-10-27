"""Device linking: login by e-mail and password or by pairing code, both of which issue the credential."""

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from eclume_server.accounts import NOTICE_VERSION
from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.devices import (
    create_pairing_code,
    issue_credential,
    link_token,
    pairing_code_json,
    redeem_pairing_code,
)
from eclume_server.problems import ApiProblemError, not_found, notice_required
from eclume_server.ratelimit import PAIR_GLOBAL_FACTOR, attempts, client_ip
from eclume_server.routes.auth import check_email, user_password_login
from eclume_server.server_info import server_info

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
SessionUser = Annotated[Principal, Depends(requires(session_only=True))]
Platform = Literal["windows", "macos", "linux", "ios", "android"]


class DeviceLogin(BaseModel):
    """Schema `DeviceLogin`."""

    email: str
    password: str = Field(min_length=1, max_length=1024)
    device_name: str = Field(min_length=1, max_length=100)
    platform: Platform

    _email = field_validator("email")(check_email)


class DevicePair(BaseModel):
    """Schema `DevicePair`."""

    code: str = Field(min_length=1, max_length=32)
    device_name: str = Field(min_length=1, max_length=100)
    platform: Platform


@router.post("/devices/login", status_code=201)
async def device_login(
    body: DeviceLogin, request: Request, ctx: Ctx, _: Annotated[None, Depends(attempts("devices_login"))]
) -> dict[str, Any]:
    """Check the password like the browser login and issue the device token.

    An account without acceptance of the current notice gets no new credential: 403 `notice_required`.
    """
    user_id = await user_password_login(ctx, body.email, body.password, client_ip(request))
    async with system_tx(ctx.engine) as conn:
        accepted = await conn.scalar(select(t.users.c.notice_version).where(t.users.c.id == user_id))
        if accepted != NOTICE_VERSION:
            raise notice_required()
        server = server_info(ctx.settings, str(request.base_url))
        return await issue_credential(conn, user_id, body.device_name, body.platform, server)


@router.post("/devices/pairing-codes", status_code=201)
async def new_pairing_code(principal: SessionUser, request: Request, ctx: Ctx) -> dict[str, Any]:
    """A 6-character code for 10 minutes, with the QR link; expires the earlier pending ones."""
    server = server_info(ctx.settings, str(request.base_url))
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await create_pairing_code(conn, principal.user_id, ctx.settings.secret_key, server)


@router.get("/devices/pairing-codes/{pairing_code_id}")
async def get_pairing_code(pairing_code_id: UUID, principal: SessionUser, ctx: Ctx) -> dict[str, Any]:
    """The code's state (`pending`, `used`, `expired`) and the credential it issued."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        query = t.pairing_codes.select().where(t.pairing_codes.c.id == pairing_code_id)
        row = (await conn.execute(query)).mappings().first()
    if row is None:
        raise not_found("Código de pareamento inexistente ou sem acesso.")
    return pairing_code_json(row)


@router.post("/devices/pair", status_code=201)
async def pair_device(
    body: DevicePair,
    request: Request,
    ctx: Ctx,
    _: Annotated[None, Depends(attempts("devices_pair", global_factor=PAIR_GLOBAL_FACTOR))],
) -> dict[str, Any]:
    """Exchange the code (single use) for its owner's device credential."""
    async with system_tx(ctx.engine) as conn:
        code = await redeem_pairing_code(conn, body.code, ctx.settings.secret_key)
        if code is None:
            raise ApiProblemError(
                401,
                "invalid_pairing_code",
                "Código de pareamento inválido, vencido ou já usado.",
                headers={"WWW-Authenticate": 'Bearer realm="eclume"'},
            )
        server = server_info(ctx.settings, str(request.base_url))
        credential = await issue_credential(conn, code["user_id"], body.device_name, body.platform, server)
        await link_token(conn, code["id"], credential["token"]["id"])
    return credential
