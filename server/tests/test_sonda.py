"""Sonda leve de fila (`python -m eclume_server.sonda`) e o custo de import do CLI."""

from __future__ import annotations

import json
import subprocess
import sys
from typing import TYPE_CHECKING

import redis

from eclume_server import sonda

if TYPE_CHECKING:
    import pytest

    from eclume_server_testing.harness import Services

PESADOS = ("anthropic", "fastapi", "sqlalchemy")


def _modulos_depois_de(codigo: str) -> set[str]:
    """Roda `codigo` num interpretador limpo e devolve os módulos de topo importados."""
    script = f"import sys, json\n{codigo}\nprint(json.dumps(sorted({{m.split('.')[0] for m in sys.modules}})))"
    saida = subprocess.run([sys.executable, "-c", script], check=True, capture_output=True, text=True).stdout  # noqa: S603
    return set(json.loads(saida))


def test_sonda_nao_importa_o_peso_da_api():
    modulos = _modulos_depois_de("import eclume_server.sonda, redis.asyncio")
    assert {m for m in PESADOS if m in modulos} == set()


def test_cli_so_importa_o_ramo_que_roda():
    modulos = _modulos_depois_de("from eclume_server import cli; cli.build_parser()")
    assert {m for m in (*PESADOS, "boto3", "argon2") if m in modulos} == set()


def test_sonda_sem_argumentos_ou_com_verbo_errado_sai_2(capsys: pytest.CaptureFixture[str]):
    assert sonda.main([]) == 2
    assert sonda.main(["fila"]) == 2
    assert sonda.main(["outra", "default"]) == 2
    assert "uso:" in capsys.readouterr().err


def test_sonda_checa_as_duas_filas_numa_chamada(monkeypatch: pytest.MonkeyPatch, services: Services):
    monkeypatch.setenv("ECLUME_REDIS_URL", services.settings.redis_url)
    client = redis.Redis.from_url(services.settings.redis_url)
    chaves = ("eclume:default:health-check", "eclume:agents:health-check")
    client.delete(*chaves)
    try:
        assert sonda.main(["fila", "default", "agents"]) == 1
        client.set(chaves[0], "j_complete=1", ex=16)
        assert sonda.main(["fila", "default"]) == 0
        assert sonda.main(["fila", "default", "agents"]) == 1
        client.set(chaves[1], "j_complete=1", ex=16)
        assert sonda.main(["fila", "default", "agents"]) == 0
    finally:
        client.delete(*chaves)
