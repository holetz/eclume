"""Rotas da API v1."""

from __future__ import annotations

from typing import TYPE_CHECKING

from eclume_server.routes import (
    admin,
    admin_health,
    admin_invitations,
    admin_secrets,
    admin_settings,
    agent_providers,
    auth,
    collections,
    groups,
    people,
    recordings,
    search,
    summaries,
    tokens,
    transcripts,
    uploads,
)
from eclume_server.routes.not_implemented import include_not_implemented

if TYPE_CHECKING:
    from fastapi import FastAPI

PREFIX = "/api/v1"


def include_routes(app: FastAPI) -> None:
    """Registra as rotas implementadas."""
    for module in (
        auth,
        tokens,
        uploads,
        recordings,
        transcripts,
        groups,
        admin,
        admin_health,
        admin_invitations,
        admin_secrets,
        admin_settings,
        agent_providers,
        summaries,
        people,
        collections,
        search,
    ):
        app.include_router(module.router, prefix=PREFIX)
    # URLs assinadas de mídia: fora de /api/v1, opacas para o cliente.
    app.include_router(recordings.media_router)
    # Depois das implementadas: as rotas pendentes nunca encobrem uma rota real.
    include_not_implemented(app)
