"""Rotas da API v1."""

from __future__ import annotations

from typing import TYPE_CHECKING

from eclume_server.routes import admin, auth, groups, tokens

if TYPE_CHECKING:
    from fastapi import FastAPI

PREFIX = "/api/v1"


def include_routes(app: FastAPI) -> None:
    """Registra as rotas implementadas."""
    for module in (auth, tokens, groups, admin):
        app.include_router(module.router, prefix=PREFIX)
