"""The eclume FastAPI app (`uvicorn eclume_server.app:create_app --factory`)."""

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

access_log = logging.getLogger("eclume_server.access")
REQUEST_ID_HEADER = b"x-request-id"
# The compose probe and the panel hit this all the time: a successful access is not logged.
HEALTH_PATH = "/api/v1/health"
# A received id is reused only when it is short and carries nothing that injects into the log or header.
_REQUEST_ID_OK = re.compile(r"[A-Za-z0-9._-]{1,128}")


class RequestIdMiddleware:
    """Gives each HTTP request an `X-Request-ID` (the received one or a new one) and logs the access.

    The access log records method, path, status and duration; never the query string (part and
    audio URLs are signed) nor headers. `/api/v1/health/*` appears only when it fails (4xx/5xx).
    """

    def __init__(self, app: ASGIApp) -> None:
        """Wrap `app`."""
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Serve the request with the id in the log context and in the response header."""
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
            path = scope["path"]
            if status >= 400 or not (path == HEALTH_PATH or path.startswith(HEALTH_PATH + "/")):  # noqa: PLR2004
                access_log.info("%s %s %d %.0fms", scope["method"], path, status, elapsed_ms)
            request_id.reset(token)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the app; without `settings`, read them from the environment."""
    settings = settings or get_settings()
    configurar_logs()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = make_runtime_engine(settings)
        queue = await Queue.connect(settings.redis_url)
        app.state.ctx = AppContext(settings=settings, engine=engine, storage=Storage(settings), queue=queue)
        try:
            # A sub-app's lifespan never runs: the MCP session manager runs here.
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
