"""Separação das filas `eclume:default` e `eclume:agents` nos parâmetros dos workers arq."""

from __future__ import annotations

from typing import Any

from eclume_server.config import Settings
from eclume_server.worker import agent_worker_settings, worker_settings

AGENT_JOBS = {
    "summarize",
    "fill_fields",
    "detect_agenda_type",
    "run_preview",
    "summary_chat",
    "base_chat",
    "agent_turn",
    "agent_action",
}


def _nomes(params: dict[str, Any]) -> set[str]:
    return {getattr(f, "name", None) or f.__name__ for f in params["functions"]}


def test_fila_default_nao_roda_mais_jobs_de_agente():
    default = _nomes(worker_settings(Settings()))
    assert default.isdisjoint(AGENT_JOBS)
    assert {"ingest_transcript", "transcription_failed", "purge_embedding_objects"} <= default


def test_fila_de_agentes_roda_so_os_jobs_de_agente_e_sem_cron():
    params = agent_worker_settings(Settings())
    assert _nomes(params) == AGENT_JOBS
    assert not params["cron_jobs"]


def test_poll_delay_por_fila():
    assert worker_settings(Settings())["poll_delay"] == 2
    assert agent_worker_settings(Settings())["poll_delay"] == 1
