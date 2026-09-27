"""App FastAPI do eclume (`uvicorn eclume_server.app:create_app --factory`)."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from fastapi import FastAPI

from eclume_server import __version__
from eclume_server.config import Settings, get_settings
from eclume_server.context import AppContext
from eclume_server.db.session import make_engine
from eclume_server.mcp_server.app import mount_mcp
from eclume_server.problems import install_handlers
from eclume_server.queue import Queue
from eclume_server.routes import include_routes
from eclume_server.storage import Storage

if TYPE_CHECKING:
    from collections.abc import AsyncIterator


def create_app(settings: Settings | None = None) -> FastAPI:
    """Monta o app; sem `settings`, lê do ambiente."""
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = make_engine(settings.database_url)
        queue = await Queue.connect(settings.redis_url)
        app.state.ctx = AppContext(settings=settings, engine=engine, storage=Storage(settings), queue=queue)
        try:
            # O lifespan de um subapp nunca roda: o session manager do MCP roda aqui.
            async with mcp.session_manager.run():
                yield
        finally:
            await queue.close()
            await engine.dispose()

    app = FastAPI(title="eclume API", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)
    install_handlers(app)
    include_routes(app)
    mcp = mount_mcp(app)
    return app
