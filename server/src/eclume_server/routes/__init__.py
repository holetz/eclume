"""Rotas da API v1."""

from __future__ import annotations

from typing import TYPE_CHECKING

from eclume_server.routes import (
    admin,
    admin_agenda_types,
    admin_auth,
    admin_health,
    admin_jobs,
    admin_secrets,
    admin_settings,
    agenda_types,
    agent,
    agent_providers,
    auth,
    base_chat,
    collections,
    devices,
    exports,
    fields,
    markers,
    people,
    previews,
    privacy,
    recordings,
    search,
    server_info,
    speaker_naming,
    summaries,
    summary_chat,
    tags,
    tokens,
    transcription,
    transcripts,
    uploads,
    voice,
)

if TYPE_CHECKING:
    from fastapi import FastAPI

PREFIX = "/api/v1"


def include_routes(app: FastAPI) -> None:
    """Registra as rotas implementadas."""
    for module in (
        auth,
        server_info,
        privacy,
        devices,
        tokens,
        uploads,
        recordings,
        markers,
        exports,
        transcripts,
        admin_auth,
        admin,
        admin_health,
        admin_jobs,
        admin_secrets,
        admin_settings,
        admin_agenda_types,
        agent_providers,
        summaries,
        summary_chat,
        base_chat,
        agent,
        agenda_types,
        fields,
        previews,
        people,
        collections,
        tags,
        search,
        voice,
        transcription,
        speaker_naming,
    ):
        app.include_router(module.router, prefix=PREFIX)
    # URLs assinadas de mídia: fora de /api/v1, opacas para o cliente.
    app.include_router(recordings.media_router)
