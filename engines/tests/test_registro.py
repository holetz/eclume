"""Formato JSON do log e contexto por `ContextVar`."""

from __future__ import annotations

import io
import json
import logging

from eclume_engines import registro


def _linhas(stream: io.StringIO) -> list[dict]:
    return [json.loads(linha) for linha in stream.getvalue().splitlines()]


def test_linha_json_com_campos_basicos():
    stream = io.StringIO()
    registro.configurar_logs(stream=stream)
    logging.getLogger("eclume_server.teste").info("olá %s", "mundo")
    (linha,) = _linhas(stream)
    assert linha["msg"] == "olá mundo"
    assert linha["level"] == "INFO"
    assert linha["logger"] == "eclume_server.teste"
    assert linha["ts"].endswith("Z")
    assert "T" in linha["ts"]
    assert "request_id" not in linha
    assert "job_id" not in linha


def test_contexto_sai_quando_definido():
    stream = io.StringIO()
    registro.configurar_logs(stream=stream)
    token = registro.request_id.set("req-1")
    registro.contexto_do_job("job-9", "rec-3", 2)
    try:
        logging.getLogger("eclume_worker.jobs").info("rodando")
    finally:
        registro.request_id.reset(token)
        registro.contexto_do_job(None)
    (linha,) = _linhas(stream)
    assert linha["request_id"] == "req-1"
    assert linha["job_id"] == "job-9"
    assert linha["recording_id"] == "rec-3"
    assert linha["revision"] == 2


def test_idempotente_e_cobre_uvicorn_e_arq():
    primeiro = io.StringIO()
    registro.configurar_logs(stream=primeiro)
    stream = io.StringIO()
    registro.configurar_logs(stream=stream)
    logging.getLogger("arq.worker").info("a")
    logging.getLogger("uvicorn.error").info("b")
    logging.getLogger("uvicorn.access").info("GET /x?sig=segredo 200")
    assert [linha["msg"] for linha in _linhas(stream)] == ["a", "b"]
    assert primeiro.getvalue() == ""


def test_cron_do_arq_so_aparece_em_warning():
    stream = io.StringIO()
    registro.configurar_logs(stream=stream)
    arq = logging.getLogger("arq.worker")
    arq.info("%6.2fs → %s(%s)", 0.0, "cron:reap_stalled_jobs:1:cron:reap_stalled_jobs", "")
    arq.info("%6.2fs → %s(%s)", 0.0, "abc:ingest_transcript", "")
    arq.warning("%6.2fs ! %s max retries %d exceeded", 1.0, "cron:x:cron:x", 3)
    assert [linha["level"] for linha in _linhas(stream)] == ["INFO", "WARNING"]
    assert "ingest_transcript" in _linhas(stream)[0]["msg"]


def test_excecao_vai_no_campo_exc():
    stream = io.StringIO()
    registro.configurar_logs(stream=stream)
    try:
        int("boom")
    except ValueError:
        logging.getLogger("eclume_engines.x").exception("falhou")
    (linha,) = _linhas(stream)
    assert "ValueError" in linha["exc"]


def test_contexto_lido_do_job_id():
    stream = io.StringIO()
    registro.configurar_logs(stream=stream)
    registro.contexto_do_job("ingest_transcript:rec-7:3")
    logging.getLogger("eclume_server.worker").info("a")
    registro.contexto_do_job("summarize:abc")
    logging.getLogger("eclume_server.worker").info("b")
    registro.contexto_do_job(None)
    primeira, segunda = _linhas(stream)
    assert primeira["recording_id"] == "rec-7"
    assert primeira["revision"] == 3
    assert segunda["job_id"] == "summarize:abc"
    assert "recording_id" not in segunda
