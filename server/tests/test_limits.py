"""Teto do corpo por rota (413 `payload_too_large`) e o 500 genérico `internal_error`."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from eclume_server.limits import CREDENTIAL_LIMIT, DEFAULT_LIMIT, BodyLimitMiddleware
from eclume_server.problems import PROBLEM_JSON, install_handlers

if TYPE_CHECKING:
    from collections.abc import Iterator

PART_SIZE = 2 * 1024 * 1024


def _app() -> FastAPI:
    app = FastAPI()
    install_handlers(app)

    @app.post("/api/v1/auth/login")
    @app.post("/api/v1/recordings")
    @app.put("/api/v1/uploads/{upload_id}/parts/{n}")
    async def echo(request: Request) -> dict[str, int]:
        return {"size": len(await request.body())}

    @app.get("/api/v1/boom")
    async def boom() -> None:
        raise RuntimeError("falha de teste")

    app.add_middleware(BodyLimitMiddleware, part_size=PART_SIZE)
    return app


@pytest.fixture
def api() -> Iterator[TestClient]:
    with TestClient(_app(), raise_server_exceptions=False) as client:
        yield client


def _chunks(size: int) -> Iterator[bytes]:
    sent = 0
    while sent < size:
        step = min(16 * 1024, size - sent)
        yield b"x" * step
        sent += step


@pytest.mark.parametrize(
    ("method", "path", "limit"),
    [
        ("POST", "/api/v1/auth/login", CREDENTIAL_LIMIT),
        ("POST", "/api/v1/recordings", DEFAULT_LIMIT),
        ("PUT", "/api/v1/uploads/abc/parts/1", PART_SIZE),
    ],
)
def test_teto_por_rota_aceita_o_limite_e_recusa_um_byte_a_mais(api: TestClient, method: str, path: str, limit: int):
    assert api.request(method, path, content=b"x" * limit).json() == {"size": limit}
    response = api.request(method, path, content=b"x" * (limit + 1))
    assert response.status_code == 413
    assert response.headers["content-type"] == PROBLEM_JSON
    assert response.json()["code"] == "payload_too_large"
    assert response.json()["limit"] == limit


def test_corpo_sem_content_length_e_contado_enquanto_chega(api: TestClient):
    response = api.post("/api/v1/auth/login", content=_chunks(CREDENTIAL_LIMIT * 3))
    assert response.status_code == 413
    assert response.json()["code"] == "payload_too_large"
    assert api.post("/api/v1/auth/login", content=_chunks(1000)).json() == {"size": 1000}


def test_erro_inesperado_vira_500_problem_json_e_vai_para_o_log(api: TestClient, caplog: pytest.LogCaptureFixture):
    with caplog.at_level(logging.ERROR, logger="eclume_server.problems"):
        response = api.get("/api/v1/boom")
    assert response.status_code == 500
    assert response.headers["content-type"] == PROBLEM_JSON
    assert response.json()["code"] == "internal_error"
    assert "falha de teste" not in response.text
    assert any(record.exc_info and "falha de teste" in str(record.exc_info[1]) for record in caplog.records)


def test_app_real_recusa_o_corpo_grande_no_login(client: TestClient):
    response = client.post("/api/v1/auth/login", content=b"{" + b" " * CREDENTIAL_LIMIT + b"}")
    assert (response.status_code, response.json()["code"]) == (413, "payload_too_large")
