"""Mounting the MCP server on the FastAPI app: stateless streamable HTTP, behind the `BearerGate`."""

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
    """ASGI of `/mcp`: only a valid `Authorization: Bearer eclp_…` passes; the `Principal` goes in the scope."""

    def __init__(self, server: MCPServer) -> None:
        """The server whose session manager serves the authenticated request."""
        self.server = server

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """401 problem+json without a valid credential; otherwise the request goes on to the SDK."""
        request = Request(scope, receive)
        try:
            principal = await authenticate(request, request.app.state.ctx, bearer_only=True)
        except ApiProblemError as problem:
            await problem.response()(scope, receive, send)
            return
        scope[PRINCIPAL_KEY] = principal
        await self.server.session_manager.handle_request(scope, receive, send)


def mount_mcp(app: FastAPI) -> MCPServer:
    """Register `/mcp` (an exact route: a `Mount` would redirect `/mcp` to `/mcp/`).

    Each app has its own `MCPServer`: the session manager runs only once, in the app's lifespan.
    """
    server = MCPServer("eclume", instructions=INSTRUCTIONS)
    register(server)
    # Creates the session manager. Caddy already controls the Host and every call requires a Bearer.
    server.streamable_http_app(
        streamable_http_path=MCP_PATH,
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    app.router.routes.append(Route(MCP_PATH, endpoint=BearerGate(server), methods=["GET", "POST", "DELETE"]))
    return server
