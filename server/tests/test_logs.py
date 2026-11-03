"""JSON logs of the API and the workers: `X-Request-ID`, access log without query string, job context."""

from __future__ import annotations

import asyncio
import io
import json
import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient

from eclume_engines import registro
from eclume_server.app import RequestIdMiddleware
from eclume_server.worker import job_start


def _lines(stream: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stream.getvalue().splitlines()]


def _app() -> FastAPI:
    app = FastAPI()

    @app.get("/eco")
    def eco() -> dict:
        logging.getLogger("eclume_server.teste").info("inside")
        return {}

    @app.get("/api/v1/health/ready")
    def ready() -> dict:
        return {}

    @app.get("/api/v1/health/falha", status_code=503)
    def failing() -> dict:
        return {}

    app.add_middleware(RequestIdMiddleware)
    return app


def test_new_request_id_goes_in_the_response_and_the_log():
    stream = io.StringIO()
    registro.configurar_logs(stream=stream)
    response = TestClient(_app()).get("/eco?sig=segredo&token=x")
    rid = response.headers["x-request-id"]
    assert len(rid) == 32
    inside, access = _lines(stream)
    assert inside["request_id"] == rid
    assert access["request_id"] == rid
    assert access["logger"] == "eclume_server.access"
    assert access["msg"].startswith("GET /eco 200 ")
    assert "segredo" not in stream.getvalue()


def test_access_log_skips_the_successful_health_check():
    stream = io.StringIO()
    registro.configurar_logs(stream=stream)
    client = TestClient(_app())
    assert client.get("/api/v1/health/ready").status_code == 200
    assert _lines(stream) == []
    assert client.get("/api/v1/health/falha").status_code == 503
    (access,) = _lines(stream)
    assert access["msg"].startswith("GET /api/v1/health/falha 503 ")


def test_received_request_id_is_reused_only_if_safe():
    stream = io.StringIO()
    registro.configurar_logs(stream=stream)
    client = TestClient(_app())
    assert client.get("/eco", headers={"X-Request-ID": "abc-123"}).headers["x-request-id"] == "abc-123"
    injected = client.get("/eco", headers={"X-Request-ID": "a b\nlevel=ERROR"}).headers["x-request-id"]
    assert injected != "a b\nlevel=ERROR"
    assert len(injected) == 32


def test_real_api_response_carries_x_request_id(client: TestClient):
    response = client.get("/api/v1/health")
    assert response.headers["x-request-id"]


def test_job_start_sets_the_job_context():
    stream = io.StringIO()
    registro.configurar_logs(stream=stream)

    async def job() -> None:
        await job_start({"job_id": "ingest_transcript:rec-1:2"})
        logging.getLogger("eclume_server.worker").info("ingesting")

    asyncio.run(job())
    (line,) = _lines(stream)
    assert line["job_id"] == "ingest_transcript:rec-1:2"
    assert line["recording_id"] == "rec-1"
    assert line["revision"] == 2
