"""Rotas da API v1."""

from __future__ import annotations

from typing import TYPE_CHECKING

from eclume_server.routes import (
    admin,
    admin_auth,
    admin_health,
    admin_jobs,
    admin_secrets,
    admin_settings,
    agenda_types,
    agent_providers,
    auth,
    collections,
    people,
    recordings,
    search,
    summaries,
    tokens,
    transcripts,
    uploads,
    voice,
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
        admin_auth,
        admin,
        admin_health,
        admin_jobs,
        admin_secrets,
        admin_settings,
        agent_providers,
        summaries,
        agenda_types,
        people,
        collections,
        search,
        voice,
    ):
        app.include_router(module.router, prefix=PREFIX)
    # URLs assinadas de mídia: fora de /api/v1, opacas para o cliente.
    app.include_router(recordings.media_router)
    # Depois das implementadas: as rotas pendentes nunca encobrem uma rota real.
    include_not_implemented(app)
