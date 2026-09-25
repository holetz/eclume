"""Cobertura do contrato: toda operação existe (implementada ou 501) e o validador morde."""

from __future__ import annotations

import re
import uuid
from typing import TYPE_CHECKING

import httpx

from eclume_server.routes.not_implemented import NOT_IMPLEMENTED
from eclume_server_testing.conformance import Conformance, operations

if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi.testclient import TestClient

    from eclume_server_testing.api import Account, Api


def _implemented(client: TestClient) -> set[tuple[str, str]]:
    schema = client.app.openapi()  # type: ignore[attr-defined]
    return {(method.upper(), path) for path, item in schema["paths"].items() for method in item}


def test_implementadas_mais_pendentes_sao_o_contrato_inteiro(client: TestClient):
    implemented = _implemented(client)
    pending = {(method, path) for method, path, _ in NOT_IMPLEMENTED}
    assert implemented.isdisjoint(pending)
    assert implemented | pending == operations()
    assert len(pending) == len(NOT_IMPLEMENTED)


def test_rotas_pendentes_respondem_501(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    admin = as_user(make_user(role="admin"))
    for method, path, owner in NOT_IMPLEMENTED:
        url = re.sub(r"\{speaker_id\}", "S1", path)
        url = re.sub(r"\{secret_name\}", "hf_token", url)
        url = re.sub(r"\{[^}]+\}", str(uuid.uuid4()), url)
        response = admin.request(method, url, json={} if method in {"POST", "PUT", "PATCH"} else None)
        assert response.status_code == 501, (method, path)
        body = response.json()
        assert body["code"] == "not_implemented"
        assert owner in body["detail"]


def _response(method: str, path: str, status: int, body: object) -> httpx.Response:
    request = httpx.Request(method, f"https://testserver{path}")
    return httpx.Response(status, json=body, request=request)


def test_o_validador_recusa_o_que_o_contrato_nao_diz():
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
