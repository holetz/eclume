"""Smoke do servidor MCP e do pareamento em produção, com um cliente MCP real (o SDK Python).

Prova, pela CA publicada: o descritor `/api/v1/server` (e que a impressão digital bate com a CA
dada), um PAT de leitura temporário com que o SDK `mcp` lista as ferramentas, busca e lê uma
gravação e tem a exclusão recusada por falta de escopo, e um código de pareamento que vira uma
credencial de dispositivo. Tudo o que o smoke cria é revogado no fim.

    ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password \
      | uv run python deploy/smoke_mcp.py --ca eclume-root.crt

A senha da conta de usuário vem do stdin (ou de `ECLUME_SMOKE_PASSWORD`), como no smoke_prod.py.
Runbook: docs/project/deploy-producao.md.
"""

# ruff: noqa: INP001, T201 — script avulso de operação, fora de qualquer pacote

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import ssl
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx2
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client

READ_SCOPES = ["recordings:read", "transcripts:read", "summaries:read"]
TOOLS = {
    "search_recordings",
    "get_recording",
    "list_fields_and_tags",
    "get_transcript",
    "get_summary",
    "update_summary",
    "request_summary",
    "update_fields",
    "delete_recording",
}


def _fail(message: str) -> None:
    print(f"FALHOU: {message}", file=sys.stderr)
    raise SystemExit(1)


def _step(message: str) -> None:
    print(f"ok  {message}")


def _ca_sha256(path: str) -> str:
    der = ssl.PEM_cert_to_DER_cert(Path(path).read_text(encoding="ascii"))
    return hashlib.sha256(der).hexdigest()


class Session:
    """A sessão do navegador (cookie + CSRF) com que o smoke cria e revoga o que usa."""

    def __init__(self, base: str, context: ssl.SSLContext) -> None:
        """Cliente de `base`, confiando só na CA do contexto."""
        self.http = httpx2.Client(base_url=base, verify=context, timeout=30)

    def call(self, method: str, url: str, body: dict[str, Any] | None = None, expect: int = 200) -> Any:  # noqa: ANN401
        """Requisição com o CSRF da sessão; status diferente de `expect` encerra o smoke."""
        headers = {}
        csrf = self.http.cookies.get("eclume_csrf")
        if csrf and method != "GET":
            headers["X-CSRF-Token"] = csrf
        response = self.http.request(method, url, json=body, headers=headers)
        if response.status_code != expect:
            _fail(f"{method} {url}: {response.status_code} {response.text[:300]}")
        return response.json() if response.content else None


async def _mcp(mcp_url: str, token: str, context: ssl.SSLContext) -> None:
    client = httpx2.AsyncClient(headers={"Authorization": f"Bearer {token}"}, verify=context, timeout=60)
    async with client, streamable_http_client(mcp_url, http_client=client) as streams:
        read, write = streams[0], streams[1]
        async with ClientSession(read, write) as session:
            info = await session.initialize()
            _step(f"MCP inicializado: {info.server_info.name}")
            tools = {tool.name for tool in (await session.list_tools()).tools}
            if tools != TOOLS:
                _fail(f"ferramentas: {sorted(tools)}")
            _step(f"{len(tools)} ferramentas listadas")
            found = await session.call_tool("search_recordings", {"limit": 5})
            if found.is_error:
                _fail(f"search_recordings: {found.content}")
            recordings = found.structured_content["recordings"]
            if not recordings:
                _fail("a biblioteca está vazia: nada para ler")
            first = recordings[0]
            _step(f"search_recordings: {len(recordings)} gravações; a primeira é {first['id']}")
            detail = await session.call_tool("get_recording", {"recording_id": first["id"]})
            if detail.is_error or detail.structured_content["id"] != first["id"]:
                _fail(f"get_recording: {detail.content}")
            _step(f"get_recording: {len(detail.structured_content['fields'])} campos, status por etapa")
            if first["status"] == "transcribed":
                transcript = await session.call_tool("get_transcript", {"recording_id": first["id"]})
                if transcript.is_error:
                    _fail(f"get_transcript: {transcript.content}")
                _step(f"get_transcript: {len(transcript.structured_content['text'])} caracteres")
            refused = await session.call_tool("delete_recording", {"recording_id": first["id"]})
            text = refused.content[0].text if refused.content else ""
            if not refused.is_error or "recordings:delete" not in text:
                _fail(f"delete_recording deveria ser recusado: {refused}")
            _step("delete_recording recusado: falta recordings:delete")


def main() -> int:
    """Roda o smoke; 0 quando tudo passa."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="https://192.168.15.199:8443")
    parser.add_argument("--ca", required=True, help="a CA raiz publicada em /downloads/eclume-root.crt")
    parser.add_argument("--email", default=os.environ.get("ECLUME_ADMIN_EMAIL"), help="padrão: $ECLUME_ADMIN_EMAIL")
    args = parser.parse_args()
    if not args.email:
        _fail("informe a conta por --email ou ECLUME_ADMIN_EMAIL")
    password = os.environ.get("ECLUME_SMOKE_PASSWORD") or sys.stdin.readline().strip()
    context = ssl.create_default_context(cafile=args.ca)

    session = Session(args.base, context)
    server = session.call("GET", "/api/v1/server")
    if server["ca_sha256"] != _ca_sha256(args.ca):
        _fail(f"impressão digital do descritor ({server['ca_sha256']}) não é a da CA dada")
    _step(
        f"descritor: {server['name']} em {server['url']}, MCP em {server['mcp_url']}, contrato {server['contract_version']}"
    )

    session.call("POST", "/api/v1/auth/login", {"email": args.email, "password": password}, expect=204)
    expires = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    created = session.call(
        "POST", "/api/v1/tokens", {"name": "smoke MCP", "scopes": READ_SCOPES, "expires_at": expires}, expect=201
    )
    cleanup = [created["token"]["id"]]
    try:
        asyncio.run(_mcp(server["mcp_url"], created["secret"], context))

        code = session.call("POST", "/api/v1/devices/pairing-codes", expect=201)
        if f"codigo={code['code']}" not in code["pair_url"] or f"ca={server['ca_sha256']}" not in code["pair_url"]:
            _fail(f"pair_url: {code['pair_url']}")
        _step(f"código de pareamento {code['display']} com o link do QR")
        device = httpx2.post(
            f"{args.base}/api/v1/devices/pair",
            json={"code": code["display"].lower(), "device_name": "smoke de pareamento", "platform": "linux"},
            verify=context,
            timeout=30,
        )
        if device.status_code != 201:  # noqa: PLR2004
            _fail(f"POST /devices/pair: {device.status_code} {device.text[:300]}")
        credential = device.json()
        cleanup.append(credential["token"]["id"])
        if credential["token"]["kind"] != "device":
            _fail(f"credencial: {json.dumps(credential['token'])}")
        state = session.call("GET", f"/api/v1/devices/pairing-codes/{code['id']}")
        if (state["status"], state["token_id"]) != ("used", credential["token"]["id"]):
            _fail(f"estado do código: {state}")
        me = httpx2.get(
            f"{args.base}/api/v1/me",
            headers={"Authorization": f"Bearer {credential['secret']}"},
            verify=context,
            timeout=30,
        ).json()
        _step(f"pareamento virou o token de dispositivo de {me['user']['email']}")
    finally:
        for token_id in cleanup:
            session.call("DELETE", f"/api/v1/tokens/{token_id}", expect=204)
        print(f"revogados {len(cleanup)} tokens do smoke")
    print("smoke MCP ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
