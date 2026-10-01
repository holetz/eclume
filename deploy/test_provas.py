# ruff: noqa: INP001, S101, S106, S603, D103, PLR2004  # testes soltos dos scripts de deploy; deploy/ não é pacote Python
"""As provas não escrevem na produção: o `smoke_prod.py` recusa a URL dela sem `--somente-leitura`."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

SMOKE = Path(__file__).with_name("smoke_prod.py")
_spec = importlib.util.spec_from_file_location("smoke_prod", SMOKE)
assert _spec is not None
assert _spec.loader is not None
smoke = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smoke)


def rodar(*args: str, **env: str) -> subprocess.CompletedProcess[str]:
    ambiente = {k: v for k, v in os.environ.items() if k != "ECLUME_PUBLIC_URL"} | env
    return subprocess.run(
        [sys.executable, str(SMOKE), *args],
        env=ambiente,
        input="",
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )


def test_alvo_padrao_e_o_staging() -> None:
    assert smoke.STAGING == "https://127.0.0.1:18444"
    assert not smoke.e_producao(smoke.STAGING)


@pytest.mark.parametrize(
    ("url", "publica", "esperado"),
    [
        ("https://192.168.15.199:8443", None, True),
        ("https://192.168.15.199:8443/", None, True),
        ("https://eclume.lan:8443", "https://eclume.lan:8443", True),
        ("https://127.0.0.1:18444", "https://eclume.lan:8443", False),
        ("https://192.168.15.199:18444", None, False),
    ],
)
def test_e_producao(monkeypatch: pytest.MonkeyPatch, url: str, publica: str | None, esperado: bool) -> None:  # noqa: FBT001
    if publica:
        monkeypatch.setenv("ECLUME_PUBLIC_URL", publica)
    else:
        monkeypatch.delenv("ECLUME_PUBLIC_URL", raising=False)
    assert smoke.e_producao(url) is esperado


def test_recusa_escrever_na_producao_antes_de_qualquer_requisicao() -> None:
    r = rodar("--url", "https://192.168.15.199:8443")

    assert r.returncode == 2
    assert "somente-leitura" in r.stderr


def test_recusa_a_url_publica_do_env() -> None:
    r = rodar("--url", "https://127.0.0.1:1", ECLUME_PUBLIC_URL="https://127.0.0.1:1")

    assert r.returncode == 2


def test_somente_leitura_aceita_a_producao() -> None:
    # A porta fechada derruba a primeira requisição: passou da recusa, sem saída 2.
    r = rodar(
        "--url",
        "https://127.0.0.1:1",
        "--somente-leitura",
        ECLUME_PUBLIC_URL="https://127.0.0.1:1",
        ECLUME_SMOKE_PASSWORD="x",
    )

    assert r.returncode not in (0, 2)
