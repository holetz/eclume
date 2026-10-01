# ruff: noqa: INP001, S101  # testes soltos dos scripts de deploy; deploy/ não é pacote Python
"""Forma do compose de produção: healthchecks dos serviços da aplicação."""

from __future__ import annotations

from pathlib import Path

import yaml

COMPOSE = yaml.safe_load((Path(__file__).with_name("docker-compose.prod.yml")).read_text(encoding="utf-8"))
SERVICES = COMPOSE["services"]


def test_healthcheck_do_server_e_a_prontidao() -> None:
    """O server fica unhealthy com Postgres, Redis ou MinIO fora."""
    test = " ".join(SERVICES["server"]["healthcheck"]["test"])
    assert "/api/v1/health/ready" in test


def test_healthcheck_dos_workers_arq_pela_chave_da_fila() -> None:
    """Cada worker arq é sondado pela chave de health-check da própria fila."""
    assert SERVICES["worker-cpu"]["healthcheck"]["test"] == ["CMD", "eclume-server", "sonda", "fila", "default"]
    assert SERVICES["worker-agents"]["healthcheck"]["test"] == ["CMD", "eclume-server", "sonda", "fila", "agents"]


def test_healthcheck_do_worker_gpu_pelo_heartbeat_com_folga_para_o_modelo() -> None:
    """O worker GPU é sondado pelo heartbeat, com folga para a carga do modelo."""
    check = SERVICES["worker-gpu"]["healthcheck"]
    assert check["test"] == ["CMD", "python", "-m", "eclume_worker.health", "--sonda"]
    assert check["start_period"] == "120s"


def test_healthcheck_em_todo_servico_da_aplicacao_que_fica_no_ar() -> None:
    """Server e workers têm healthcheck."""
    for name in ("server", "worker-cpu", "worker-agents", "worker-gpu"):
        assert "healthcheck" in SERVICES[name], name
