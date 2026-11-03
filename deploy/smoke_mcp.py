"""Smoke of the MCP server and of pairing in production, with a real MCP client (the Python SDK).

Proves, through the published CA: the `/api/v1/server` descriptor (and that the fingerprint matches
the given CA), a temporary read PAT with which the `mcp` SDK lists the tools, searches and reads a
recording and has the deletion refused for lack of scope, and a pairing code that becomes a device
credential. Everything the smoke creates is revoked at the end.

    ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password \
      | uv run python deploy/smoke_mcp.py --ca eclume-root.crt

The user account password comes from stdin (or `ECLUME_SMOKE_PASSWORD`), as in smoke_prod.py.
Runbook: docs/project/deploy-producao.md.
"""

# ruff: noqa: INP001, T201 — standalone operations script, outside any package

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
    print(f"FAILED: {message}", file=sys.stderr)
    raise SystemExit(1)


def _step(message: str) -> None:
    print(f"ok  {message}")


def _ca_sha256(path: str) -> str:
    der = ssl.PEM_cert_to_DER_cert(Path(path).read_text(encoding="ascii"))
    return hashlib.sha256(der).hexdigest()


class Session:
    """The browser session (cookie + CSRF) with which the smoke creates and revokes what it uses."""

    def __init__(self, base: str, context: ssl.SSLContext) -> None:
        """Client of `base`, trusting only the context's CA."""
        self.http = httpx2.Client(base_url=base, verify=context, timeout=30)

    def call(self, method: str, url: str, body: dict[str, Any] | None = None, expect: int = 200) -> Any:  # noqa: ANN401
        """Request with the session CSRF; a status other than `expect` ends the smoke."""
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
            _step(f"MCP initialized: {info.server_info.name}")
            tools = {tool.name for tool in (await session.list_tools()).tools}
            if tools != TOOLS:
                _fail(f"tools: {sorted(tools)}")
            _step(f"{len(tools)} tools listed")
            found = await session.call_tool("search_recordings", {"limit": 5})
            if found.is_error:
                _fail(f"search_recordings: {found.content}")
            recordings = found.structured_content["recordings"]
            if not recordings:
                _fail("the library is empty: nothing to read")
            first = recordings[0]
            _step(f"search_recordings: {len(recordings)} recordings; the first is {first['id']}")
            detail = await session.call_tool("get_recording", {"recording_id": first["id"]})
            if detail.is_error or detail.structured_content["id"] != first["id"]:
                _fail(f"get_recording: {detail.content}")
            _step(f"get_recording: {len(detail.structured_content['fields'])} fields, status per step")
            if first["status"] == "transcribed":
                transcript = await session.call_tool("get_transcript", {"recording_id": first["id"]})
                if transcript.is_error:
                    _fail(f"get_transcript: {transcript.content}")
                _step(f"get_transcript: {len(transcript.structured_content['text'])} characters")
            refused = await session.call_tool("delete_recording", {"recording_id": first["id"]})
            text = refused.content[0].text if refused.content else ""
            if not refused.is_error or "recordings:delete" not in text:
                _fail(f"delete_recording should be refused: {refused}")
            _step("delete_recording refused: recordings:delete is missing")


def main() -> int:
    """Runs the smoke; 0 when everything passes."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="https://192.168.15.199:8443")
    parser.add_argument("--ca", required=True, help="the root CA published at /downloads/eclume-root.crt")
    parser.add_argument("--email", default=os.environ.get("ECLUME_ADMIN_EMAIL"), help="default: $ECLUME_ADMIN_EMAIL")
    args = parser.parse_args()
    if not args.email:
        _fail("give the account through --email or ECLUME_ADMIN_EMAIL")
    password = os.environ.get("ECLUME_SMOKE_PASSWORD") or sys.stdin.readline().strip()
    context = ssl.create_default_context(cafile=args.ca)

    session = Session(args.base, context)
    server = session.call("GET", "/api/v1/server")
    if server["ca_sha256"] != _ca_sha256(args.ca):
        _fail(f"descriptor fingerprint ({server['ca_sha256']}) is not the given CA's")
    _step(
        f"descriptor: {server['name']} at {server['url']}, MCP at {server['mcp_url']}, contract {server['contract_version']}"
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
        _step(f"pairing code {code['display']} with the QR link")
        device = httpx2.post(
            f"{args.base}/api/v1/devices/pair",
            json={"code": code["display"].lower(), "device_name": "pairing smoke", "platform": "linux"},
            verify=context,
            timeout=30,
        )
        if device.status_code != 201:  # noqa: PLR2004
            _fail(f"POST /devices/pair: {device.status_code} {device.text[:300]}")
        credential = device.json()
        cleanup.append(credential["token"]["id"])
        if credential["token"]["kind"] != "device":
            _fail(f"credential: {json.dumps(credential['token'])}")
        state = session.call("GET", f"/api/v1/devices/pairing-codes/{code['id']}")
        if (state["status"], state["token_id"]) != ("used", credential["token"]["id"]):
            _fail(f"code state: {state}")
        me = httpx2.get(
            f"{args.base}/api/v1/me",
            headers={"Authorization": f"Bearer {credential['secret']}"},
            verify=context,
            timeout=30,
        ).json()
        _step(f"pairing became the device token of {me['user']['email']}")
    finally:
        for token_id in cleanup:
            session.call("DELETE", f"/api/v1/tokens/{token_id}", expect=204)
        print(f"revoked {len(cleanup)} smoke tokens")
    print("smoke MCP ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
