"""Contract coverage: every operation exists and the validator bites."""

from __future__ import annotations

from typing import TYPE_CHECKING

import httpx

from eclume_server_testing.conformance import Conformance, operations

if TYPE_CHECKING:
    from fastapi.testclient import TestClient


def _implemented(client: TestClient) -> set[tuple[str, str]]:
    schema = client.app.openapi()  # type: ignore[attr-defined]
    return {(method.upper(), path) for path, item in schema["paths"].items() for method in item}


def test_implemented_routes_are_the_whole_contract(client: TestClient):
    assert _implemented(client) == operations()


def _response(method: str, path: str, status: int, body: object) -> httpx.Response:
    request = httpx.Request(method, f"https://testserver{path}")
    return httpx.Response(status, json=body, request=request)


def test_validator_rejects_what_the_contract_does_not_say():
    checker = Conformance()
    health = {"status": "ok", "version": "0.1.0", "contract_version": "1.1.0"}
    checker.check(_response("GET", "/api/v1/health", 200, health))
    assert checker.failures == []

    checker.check(_response("GET", "/api/v1/health", 200, {**health, "extra": 1}))
    checker.check(
        _response("GET", "/api/v1/health", 200, {"status": "talvez", "version": "x", "contract_version": "y"})
    )
    checker.check(_response("GET", "/api/v1/health", 418, health))
    checker.check(_response("GET", "/api/v1/nao-existe", 200, {}))
    assert len(checker.failures) == 4
    assert "extra" in checker.failures[0]
    assert "talvez" in checker.failures[1]
    assert "status não declarado" in checker.failures[2]
    assert "fora do contrato" in checker.failures[3]
