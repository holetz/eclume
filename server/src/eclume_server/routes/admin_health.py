"""Saúde da fila, da GPU e dos modelos (`/admin/health`). Só sessão de `admin`."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.health import admin_health

router = APIRouter(prefix="/admin")
Ctx = Annotated[AppContext, Depends(get_ctx)]
Admin = Annotated[Principal, Depends(requires(session_only=True, admin=True))]


@router.get("/health")
async def get_admin_health(principal: Admin, ctx: Ctx) -> dict[str, Any]:
    """Estado atual das filas, do worker GPU e dos jobs da organização."""
    return await admin_health(ctx, principal)
