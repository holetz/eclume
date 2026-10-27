"""Per-route request body ceiling, before any full read."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from eclume_server.problems import payload_too_large

if TYPE_CHECKING:
    from starlette.types import ASGIApp, Message, Receive, Scope, Send

CREDENTIAL_LIMIT = 64 * 1024
DEFAULT_LIMIT = 1024 * 1024
_CREDENTIAL_PREFIXES = ("/api/v1/auth/", "/api/v1/admin/auth/", "/api/v1/devices/")
_PART_PATH = re.compile(r"/api/v1/uploads/[^/]+/parts/[^/]+")
# The Agent attachment: the file ceiling (`agent_files.MAX_INPUT_BYTES`) plus the multipart envelope.
_AGENT_FILE_PATH = re.compile(r"/api/v1/agent/sessions/[^/]+/files")
AGENT_FILE_LIMIT = 10 * 1024 * 1024 + 64 * 1024


class _BodyTooLargeError(Exception):
    """The body exceeded the ceiling while being read."""


class BodyLimitMiddleware:
    """Refuse with 413 `payload_too_large` a body above the route's ceiling.

    Public credentials accept 64 KiB, the upload part up to `part_size` (the route checks the exact
    size) and the rest 1 MiB. Refuses by `Content-Length` without reading and, without the header,
    counts the received bytes: past the ceiling, discards what the app would answer and returns 413.
    """

    def __init__(self, app: ASGIApp, *, part_size: int) -> None:
        """Wrap `app`; `part_size` is the ceiling of a part's `PUT`."""
        self.app = app
        self.part_size = part_size

    def limit_for(self, path: str) -> int:
        """The body ceiling for `path`."""
        if path.startswith(_CREDENTIAL_PREFIXES):
            return CREDENTIAL_LIMIT
        if _PART_PATH.fullmatch(path):
            return max(self.part_size, DEFAULT_LIMIT)
        if _AGENT_FILE_PATH.fullmatch(path):
            return AGENT_FILE_LIMIT
        return DEFAULT_LIMIT

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Serve the request within the ceiling, or answer 413."""
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = self.limit_for(scope["path"])
        declared = dict(scope["headers"]).get(b"content-length", b"")
        if declared.isdigit() and int(declared) > limit:
            await payload_too_large(limit).response()(scope, receive, send)
            return
        guard = _Guard(limit, receive, send)
        try:
            await self.app(scope, guard.receive, guard.send)
        except Exception:
            if not guard.exceeded:
                raise
        if guard.exceeded and not guard.started:
            await payload_too_large(limit).response()(scope, receive, send)


class _Guard:
    """Count the received bytes and, past the ceiling, hold back the response the app would give."""

    def __init__(self, limit: int, receive: Receive, send: Send) -> None:
        self.limit = limit
        self._receive = receive
        self._send = send
        self.received = 0
        self.exceeded = False
        self.started = False

    async def receive(self) -> Message:
        message = await self._receive()
        if message["type"] == "http.request":
            self.received += len(message.get("body", b""))
            if self.received > self.limit:
                self.exceeded = True
                raise _BodyTooLargeError
        return message

    async def send(self, message: Message) -> None:
        if self.exceeded and not self.started:
            return
        self.started = self.started or message["type"] == "http.response.start"
        await self._send(message)
