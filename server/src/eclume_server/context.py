"""Resources of the API process, created in the lifespan and read by the routes."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

# At runtime: FastAPI resolves the annotation of `get_ctx` to inject the request.
from fastapi import Request

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncEngine

    from eclume_server.config import Settings
    from eclume_server.queue import Queue
    from eclume_server.storage import Storage


@dataclass
class AppContext:
    """Configuration and clients shared by the requests."""

    settings: Settings
    engine: AsyncEngine
    storage: Storage
    queue: Queue


def get_ctx(request: Request) -> AppContext:
    """FastAPI dependency: the app context."""
    return request.app.state.ctx
