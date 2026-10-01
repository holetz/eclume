"""Teto do corpo da requisição por rota, antes de qualquer leitura inteira."""

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


class _BodyTooLargeError(Exception):
    """O corpo passou do teto enquanto era lido."""


class BodyLimitMiddleware:
    """Recusa com 413 `payload_too_large` o corpo acima do teto da rota.

    Credenciais públicas aceitam 64 KiB, a parte de upload até `part_size` (a rota confere o tamanho
    exato) e o resto 1 MiB. Recusa pelo `Content-Length` sem ler e, sem o cabeçalho, conta os bytes
    recebidos: ao passar do teto, descarta o que o app responderia e devolve o 413.
    """

    def __init__(self, app: ASGIApp, *, part_size: int) -> None:
        """Envolve `app`; `part_size` é o teto do `PUT` de uma parte."""
        self.app = app
        self.part_size = part_size

    def limit_for(self, path: str) -> int:
        """O teto do corpo para `path`."""
        if path.startswith(_CREDENTIAL_PREFIXES):
            return CREDENTIAL_LIMIT
        if _PART_PATH.fullmatch(path):
            return max(self.part_size, DEFAULT_LIMIT)
        return DEFAULT_LIMIT

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Atende a requisição dentro do teto, ou responde 413."""
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
    """Conta os bytes recebidos e, passado o teto, segura a resposta que o app tentaria dar."""

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
