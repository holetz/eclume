"""`GET /privacy`: para onde vai cada dado, pública para quem ainda vai se cadastrar."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends

from eclume_server.context import AppContext, get_ctx
from eclume_server.db.session import system_tx
from eclume_server.privacy import privacy_info

router = APIRouter()


@router.get("/privacy")
async def get_privacy_info(ctx: Annotated[AppContext, Depends(get_ctx)]) -> dict[str, Any]:
    """O destino da transcrição e de cada finalidade de agente, conforme a configuração em vigor."""
    async with system_tx(ctx.engine) as conn:
        return await privacy_info(conn)
