"""Ligação de aparelhos: login por e-mail e senha que emite a credencial de dispositivo."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, field_validator

from eclume_server.accounts import password_login
from eclume_server.context import AppContext, get_ctx
from eclume_server.db.session import system_tx
from eclume_server.devices import issue_credential
from eclume_server.problems import unauthorized
from eclume_server.ratelimit import attempts
from eclume_server.routes.auth import WRONG_PASSWORD, check_email
from eclume_server.server_info import server_info

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Platform = Literal["windows", "macos", "linux", "ios", "android"]


class DeviceLogin(BaseModel):
    """Schema `DeviceLogin`."""

    email: str
    password: str = Field(min_length=1, max_length=1024)
    device_name: str = Field(min_length=1, max_length=100)
    platform: Platform

    _email = field_validator("email")(check_email)


@router.post("/devices/login", status_code=201)
async def device_login(
    body: DeviceLogin, request: Request, ctx: Ctx, _: Annotated[None, Depends(attempts("devices_login"))]
) -> dict[str, Any]:
    """Confere a senha como o login do navegador e emite o token de dispositivo."""
    async with system_tx(ctx.engine) as conn:
        user_id = await password_login(conn, body.email, body.password)
        if user_id is None:
            raise unauthorized(WRONG_PASSWORD)
        server = server_info(ctx.settings, str(request.base_url))
        return await issue_credential(conn, user_id, body.device_name, body.platform, server)
