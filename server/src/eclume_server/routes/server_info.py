"""`GET /server`: the public descriptor that mDNS, the QR, pairing and the installer use."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request

from eclume_server.context import AppContext, get_ctx
from eclume_server.server_info import server_info

router = APIRouter()


@router.get("/server")
async def get_server_info(request: Request, ctx: Annotated[AppContext, Depends(get_ctx)]) -> dict[str, Any]:
    """Name, address, MCP address, root CA fingerprint and versions."""
    return server_info(ctx.settings, str(request.base_url))
