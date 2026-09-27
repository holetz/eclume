"""Servidor MCP em `/mcp`: Bearer, ferramentas de leitura com escopos e o uso por MCP."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import text

from eclume_server_testing.fakes import transcribed
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi.testclient import TestClient

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

READ_TOOLS = {"search_recordings", "get_recording", "list_fields_and_tags", "get_transcript", "get_summary"}
ALL_READ = ("recordings:read", "transcripts:read", "summaries:read")


def rpc(client: TestClient, token: str | None, method: str, params: dict[str, Any] | None = None) -> Any:  # noqa: ANN401
    """Uma chamada JSON-RPC ao `/mcp`, como um cliente MCP sem estado."""
    headers = {"Accept": "application/json, text/event-stream"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    client.cookies.clear()
    return client.post("/mcp", json=body, headers=headers)


def call(client: TestClient, token: str, tool: str, **arguments: Any) -> dict[str, Any]:  # noqa: ANN401
    """`tools/call`: o resultado (`structuredContent`, `isError`, `content`)."""
    response = rpc(client, token, "tools/call", {"name": tool, "arguments": arguments})
    assert response.status_code == 200, response.text
    return response.json()["result"]


def token_of(api: Api) -> str:
    assert api.token is not None
    return api.token


def test_sem_bearer_valido_e_401(client: TestClient, as_user: Callable[[Account], Api], make_user: Callable):
    session = as_user(make_user())
    for token in (None, "eclp_inexistente0000000000000000000000000000"):
        response = rpc(client, token, "tools/list")
        assert response.status_code == 401
        assert response.headers["content-type"].startswith("application/problem+json")
        assert response.headers["WWW-Authenticate"].startswith("Bearer")
    # A sessão do navegador não vale no /mcp.
    assert session.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).status_code == 401


def test_lista_as_ferramentas_a_qualquer_token(
    client: TestClient, as_user: Callable[[Account], Api], make_user: Callable
):
    token = token_of(as_user(make_user()).pat("people:read"))
    initialized = rpc(
        client,
        token,
        "initialize",
        {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "teste", "version": "1"}},
    )
    assert initialized.status_code == 200
    assert initialized.json()["result"]["serverInfo"]["name"] == "eclume"
    tools = {tool["name"]: tool for tool in rpc(client, token, "tools/list").json()["result"]["tools"]}
    assert set(tools) >= READ_TOOLS
    assert all(tools[name]["annotations"]["readOnlyHint"] for name in READ_TOOLS)
    # A recusa nomeia o escopo; a ferramenta não some da lista.
    denied = call(client, token, "list_fields_and_tags")
    assert denied["isError"] is True
    assert "recordings:read" in denied["content"][0]["text"]


def test_busca_le_e_marca_o_uso_por_mcp(
    client: TestClient, as_user: Callable[[Account], Api], make_user: Callable, services: Services
):
    session = as_user(make_user())
    recording = transcribed(session, services.settings, tags=["cliente-aurora"])
    rid = recording["id"]
    reader = session.pat(*ALL_READ, name="Claude Desktop")
    token = token_of(reader)

    listed = call(client, token, "search_recordings")
    assert listed["isError"] is False
    assert [r["id"] for r in listed["structuredContent"]["recordings"]] == [rid]
    assert call(client, token, "search_recordings", tags=["outra"])["structuredContent"]["recordings"] == []

    found = call(client, token, "search_recordings", query="lideranças")["structuredContent"]["hits"]
    assert found
    assert found[0]["recording_id"] == rid
    assert "lideranças" in found[0]["text"]

    detail = call(client, token, "get_recording", recording_id=rid)["structuredContent"]
    assert detail["id"] == rid
    assert "cliente-aurora" in detail["tags"]
    assert {f["name"] for f in detail["fields"]} >= {"Título", "Tags"}
    assert len(detail["people"]) == 3  # a fixture tem 3 locutores
    assert {step["step"] for step in detail["pipeline"]} >= {"transcription"}

    catalog = call(client, token, "list_fields_and_tags")["structuredContent"]
    assert {"name": "cliente-aurora", "count": 1} in catalog["tags"]
    assert catalog["agenda_types"]

    transcript = call(client, token, "get_transcript", recording_id=rid)["structuredContent"]
    assert transcript["text"].startswith("[00:03] ")
    assert transcript["next_start_ms"] is None
    window = call(client, token, "get_transcript", recording_id=rid, start_ms=12_000, end_ms=30_000)
    assert window["structuredContent"]["text"].splitlines()[0].startswith("[00:12] Locutor 2: Bom dia")

    assert call(client, token, "get_summary", recording_id=rid)["structuredContent"]["status"] == "missing"
    session.put(f"/api/v1/recordings/{rid}/summary", json={"content_md": "# Resumo", "base_version": 0})
    summary = call(client, token, "get_summary", recording_id=rid)["structuredContent"]
    assert (summary["status"], summary["origin"], summary["content_md"]) == ("done", "manual", "# Resumo")

    async def used(conn: Any) -> Any:  # noqa: ANN401
        query = text("SELECT mcp_last_used_at IS NOT NULL FROM api_tokens WHERE name = 'Claude Desktop'")
        return (await conn.execute(query)).scalar_one()

    assert run(services.sql(used)) is True


def test_escopos_e_gravacao_de_outra_conta(
    client: TestClient, as_user: Callable[[Account], Api], make_user: Callable, services: Services
):
    owner = as_user(make_user())
    rid = transcribed(owner, services.settings)["id"]
    recordings_only = token_of(owner.pat("recordings:read"))
    denied = call(client, recordings_only, "search_recordings", query="lideranças")
    assert denied["isError"] is True
    assert "transcripts:read" in denied["content"][0]["text"]
    assert "summaries:read" in call(client, recordings_only, "get_summary", recording_id=rid)["content"][0]["text"]

    stranger = token_of(as_user(make_user()).pat(*ALL_READ))
    other = call(client, stranger, "get_recording", recording_id=rid)
    assert other["isError"] is True
    assert "inexistente" in other["content"][0]["text"]
    assert call(client, stranger, "get_recording", recording_id="nao-e-uuid")["isError"] is True
