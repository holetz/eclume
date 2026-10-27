"""Health of the queue, the GPU and the models (`/admin/health`). Admin session only."""

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
    """Current state of the queues, the GPU worker and the platform's jobs."""
    return await admin_health(ctx)
