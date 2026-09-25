"""Recursos do processo da API, criados no lifespan e lidos pelas rotas."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

# Em runtime: o FastAPI resolve a anotação de `get_ctx` para injetar a requisição.
from fastapi import Request

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncEngine

    from eclume_server.config import Settings


@dataclass
class AppContext:
    """Configuração e clientes compartilhados pelas requisições."""

    settings: Settings
    engine: AsyncEngine


def get_ctx(request: Request) -> AppContext:
    """Dependência FastAPI: o contexto do app."""
    return request.app.state.ctx
