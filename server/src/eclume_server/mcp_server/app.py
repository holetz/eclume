"""Montagem do servidor MCP no app FastAPI: HTTP streamable sem estado, atrás do `BearerGate`."""

from __future__ import annotations

from typing import TYPE_CHECKING

from mcp.server import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.requests import Request
from starlette.routing import Route

from eclume_server.auth import authenticate
from eclume_server.mcp_server.tools import register
from eclume_server.problems import ApiProblemError

if TYPE_CHECKING:
    from fastapi import FastAPI
    from starlette.types import Receive, Scope, Send

MCP_PATH = "/mcp"
PRINCIPAL_KEY = "eclume.principal"
INSTRUCTIONS = (
    "Gravações, transcrições e resumos de reuniões e notas de voz do usuário do eclume. Busque com "
    "search_recordings, leia com get_recording, get_transcript e get_summary, e edite só com os valores "
    "que list_fields_and_tags mostra. Cada ferramenta exige um escopo do token; a recusa diz qual falta."
)


class BearerGate:
    """ASGI do `/mcp`: só `Authorization: Bearer eclp_…` válido passa; o `Principal` vai no scope."""

    def __init__(self, server: MCPServer) -> None:
        """O servidor cujo session manager atende a requisição autenticada."""
        self.server = server

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """401 problem+json sem credencial válida; senão, a requisição segue para o SDK."""
        request = Request(scope, receive)
        try:
            principal = await authenticate(request, request.app.state.ctx, bearer_only=True)
        except ApiProblemError as problem:
            await problem.response()(scope, receive, send)
            return
        scope[PRINCIPAL_KEY] = principal
        await self.server.session_manager.handle_request(scope, receive, send)


def mount_mcp(app: FastAPI) -> MCPServer:
    """Registra `/mcp` (rota exata: um `Mount` redirecionaria `/mcp` para `/mcp/`).

    Cada app tem o próprio `MCPServer`: o session manager só roda uma vez, no lifespan do app.
    """
    server = MCPServer("eclume", instructions=INSTRUCTIONS)
    register(server)
    # Cria o session manager. O Host já é controlado pelo Caddy e toda chamada exige Bearer.
    server.streamable_http_app(
        streamable_http_path=MCP_PATH,
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    app.router.routes.append(Route(MCP_PATH, endpoint=BearerGate(server), methods=["GET", "POST", "DELETE"]))
    return server
