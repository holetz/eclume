"""Separação das filas `eclume:default` e `eclume:agents` nos parâmetros dos workers arq."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from typing import TYPE_CHECKING, Any

import redis

from eclume_server.config import Settings
from eclume_server.worker import agent_worker_settings, worker_settings

if TYPE_CHECKING:
    from eclume_server_testing.harness import Services

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


def test_worker_unico_sobe_as_duas_filas_e_encerra_no_sigterm(services: Services):
    env = os.environ | {
        f"ECLUME_{name.upper()}": str(value) for name, value in services.settings.model_dump().items() if value
    }
    client = redis.Redis.from_url(services.settings.redis_url)
    chaves = ["eclume:default:health-check", "eclume:agents:health-check"]
    client.delete(*chaves)
    proc = subprocess.Popen(
        [sys.executable, "-m", "eclume_server.cli", "worker"], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
    )
    try:
        deadline = time.monotonic() + 30
        while client.exists(*chaves) < len(chaves):
            assert proc.poll() is None, proc.stdout.read().decode() if proc.stdout else ""
            assert time.monotonic() < deadline, "as duas chaves de health-check não apareceram"
            time.sleep(0.2)
        proc.send_signal(signal.SIGTERM)
        saida, _ = proc.communicate(timeout=20)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    assert proc.returncode == 0, saida.decode()
    assert client.exists(*chaves) == 0  # cada worker apagou a própria chave ao fechar
    assert saida.decode().count("shutdown on SIGTERM") == 2
