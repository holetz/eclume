# ruff: noqa: INP001, S101, D103  # testes soltos dos scripts de deploy; deploy/ não é pacote Python
"""Testes do `pulos.py`: pulo fora da lista falha, listado passa, listado ausente falha."""

from __future__ import annotations

import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("pulos", Path(__file__).with_name("pulos.py"))
assert _spec is not None
assert _spec.loader is not None
pulos = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pulos)

RAIZ = Path(__file__).resolve().parent
LISTA = "# c\nworker-gpu/tests/test_a.py::test_um | motivo\n"


def relatorio(*casos: tuple[str, str, bool]) -> str:
    pulo = '<skipped message="x"/>'
    itens = "".join(f'<testcase classname="{c}" name="{n}">{pulo if s else ""}</testcase>' for c, n, s in casos)
    return f"<testsuites><testsuite>{itens}</testsuite></testsuites>"


def problemas(xml: str, lista: str = LISTA) -> list[str]:
    return pulos.comparar(pulos.ler_pulos(xml), pulos.ler_lista(lista))


def test_pulo_listado_passa() -> None:
    assert problemas(relatorio(("worker-gpu.tests.test_a", "test_um", True), ("x.test_b", "test_ok", False))) == []


def test_pulo_fora_da_lista_falha() -> None:
    out = problemas(relatorio(("worker-gpu.tests.test_a", "test_um", True), ("server.tests.test_b", "test_novo", True)))
    assert len(out) == 1
    assert "test_novo" in out[0]


def test_pulo_listado_que_nao_ocorreu_falha() -> None:
    out = problemas(relatorio(("worker-gpu.tests.test_a", "test_um", False)))
    assert len(out) == 1
    assert "apodrecida" in out[0]


def test_listas_do_repo_so_diferem_no_claude_real() -> None:
    ci = pulos.ler_lista((RAIZ / "pulos-esperados-ci.txt").read_text())
    gate = pulos.ler_lista((RAIZ / "pulos-esperados-gate.txt").read_text())
    assert ci - gate == {c for c in ci if "test_agents_real" in c}
    assert gate <= ci
