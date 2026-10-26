"""Log JSON da API e dos workers: `X-Request-ID`, log de acesso sem query string, contexto do job."""

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


def _linhas(stream: io.StringIO) -> list[dict]:
    return [json.loads(linha) for linha in stream.getvalue().splitlines()]


def _app() -> FastAPI:
    app = FastAPI()

    @app.get("/eco")
    def eco() -> dict:
        logging.getLogger("eclume_server.teste").info("dentro")
        return {}

    @app.get("/api/v1/health/ready")
    def pronto() -> dict:
        return {}

    @app.get("/api/v1/health/falha", status_code=503)
    def falha() -> dict:
        return {}

    app.add_middleware(RequestIdMiddleware)
    return app


def test_request_id_novo_vai_na_resposta_e_no_log():
    stream = io.StringIO()
    registro.configurar_logs(stream=stream)
    response = TestClient(_app()).get("/eco?sig=segredo&token=x")
    rid = response.headers["x-request-id"]
    assert len(rid) == 32
    dentro, acesso = _linhas(stream)
    assert dentro["request_id"] == rid
    assert acesso["request_id"] == rid
    assert acesso["logger"] == "eclume_server.access"
    assert acesso["msg"].startswith("GET /eco 200 ")
    assert "segredo" not in stream.getvalue()


def test_log_de_acesso_pula_o_health_que_deu_certo():
    stream = io.StringIO()
    registro.configurar_logs(stream=stream)
    client = TestClient(_app())
    assert client.get("/api/v1/health/ready").status_code == 200
    assert _linhas(stream) == []
    assert client.get("/api/v1/health/falha").status_code == 503
    (acesso,) = _linhas(stream)
    assert acesso["msg"].startswith("GET /api/v1/health/falha 503 ")


def test_request_id_recebido_e_reaproveitado_so_se_for_seguro():
    stream = io.StringIO()
    registro.configurar_logs(stream=stream)
    client = TestClient(_app())
    assert client.get("/eco", headers={"X-Request-ID": "abc-123"}).headers["x-request-id"] == "abc-123"
    injetado = client.get("/eco", headers={"X-Request-ID": "a b\nlevel=ERROR"}).headers["x-request-id"]
    assert injetado != "a b\nlevel=ERROR"
    assert len(injetado) == 32


def test_resposta_da_api_real_leva_x_request_id(client: TestClient):
    response = client.get("/api/v1/health")
    assert response.headers["x-request-id"]


def test_job_start_define_o_contexto_do_job():
    stream = io.StringIO()
    registro.configurar_logs(stream=stream)

    async def job() -> None:
        await job_start({"job_id": "ingest_transcript:rec-1:2"})
        logging.getLogger("eclume_server.worker").info("ingerindo")

    asyncio.run(job())
    (linha,) = _linhas(stream)
    assert linha["job_id"] == "ingest_transcript:rec-1:2"
    assert linha["recording_id"] == "rec-1"
    assert linha["revision"] == 2
