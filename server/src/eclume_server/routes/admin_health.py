"""Saúde da fila, da GPU e dos modelos (`/admin/health`). Só a sessão de admin."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends

from eclume_server.auth import require_admin
from eclume_server.context import AppContext, get_ctx
from eclume_server.health import admin_health

router = APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])
Ctx = Annotated[AppContext, Depends(get_ctx)]


@router.get("/health")
async def get_admin_health(ctx: Ctx) -> dict[str, Any]:
    """Estado atual das filas, do worker GPU e dos jobs da plataforma."""
    return await admin_health(ctx)
