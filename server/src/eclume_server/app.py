"""App FastAPI do eclume (`uvicorn eclume_server.app:create_app --factory`)."""

from __future__ import annotations

import logging
import re
import time
import uuid
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from fastapi import FastAPI

from eclume_engines.registro import configurar_logs, request_id
from eclume_server import __version__
from eclume_server.config import Settings, get_settings
from eclume_server.context import AppContext
from eclume_server.db.session import make_runtime_engine
from eclume_server.limits import BodyLimitMiddleware
from eclume_server.mcp_server.app import mount_mcp
from eclume_server.problems import install_handlers
from eclume_server.queue import Queue
from eclume_server.routes import include_routes
from eclume_server.storage import Storage

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from starlette.types import ASGIApp, Message, Receive, Scope, Send

access_log = logging.getLogger("eclume_server.acesso")
REQUEST_ID_HEADER = b"x-request-id"
# O id recebido só é reaproveitado se for curto e sem nada que injete no log ou no cabeçalho.
_REQUEST_ID_OK = re.compile(r"[A-Za-z0-9._-]{1,128}")


class RequestIdMiddleware:
    """Dá a cada requisição HTTP um `X-Request-ID` (o recebido ou um novo) e registra o acesso.

    O log de acesso grava método, caminho, status e duração; nunca a query string (as URLs de parte
    e de áudio são assinadas) nem cabeçalhos.
    """

    def __init__(self, app: ASGIApp) -> None:
        """Envolve `app`."""
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Atende a requisição com o id no contexto de log e no cabeçalho da resposta."""
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        received = dict(scope["headers"]).get(REQUEST_ID_HEADER, b"").decode("latin-1")
        rid = received if _REQUEST_ID_OK.fullmatch(received) else uuid.uuid4().hex
        token = request_id.set(rid)
        status = 500
        start = time.perf_counter()

        async def send_with_id(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != REQUEST_ID_HEADER]
                message["headers"] = [*headers, (REQUEST_ID_HEADER, rid.encode())]
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        finally:
            elapsed_ms = (time.perf_counter() - start) * 1000
            access_log.info("%s %s %d %.0fms", scope["method"], scope["path"], status, elapsed_ms)
            request_id.reset(token)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Monta o app; sem `settings`, lê do ambiente."""
    settings = settings or get_settings()
    configurar_logs()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = make_runtime_engine(settings)
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
    app.add_middleware(BodyLimitMiddleware, part_size=settings.upload_part_size)
    app.add_middleware(RequestIdMiddleware)
    return app
