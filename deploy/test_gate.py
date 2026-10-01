# ruff: noqa: INP001, S101  # testes soltos dos scripts de deploy; deploy/ não é pacote Python
"""Testes do `gate.py`: a decisão sobre o status `eclume/gate`, a descrição e os alvos do push."""

from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("gate", Path(__file__).with_name("gate.py"))
assert _spec is not None
assert _spec.loader is not None
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)

SHA = "a" * 40
LOG = f"~/eclume-gate/logs/{SHA}.log"


def combinado(*statuses: tuple[str, str]) -> dict[str, object]:
    """Um status combinado do GitHub com um status por contexto."""
    return {"state": "pending", "statuses": [{"context": c, "state": s} for c, s in statuses]}


def rodar(
    argv: list[str], entrada: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> tuple[int, str]:
    """Roda o `gate.main` com a entrada no stdin e devolve (código, saída)."""
    monkeypatch.setattr("sys.stdin", io.StringIO(entrada))
    codigo = gate.main(argv)
    return codigo, capsys.readouterr().out


# --- decidir --------------------------------------------------------------------------------------


def test_decidir_libera_so_com_o_gate_em_success() -> None:
    """Só `success` libera; os outros estados recusam dizendo o estado."""
    assert gate.decidir(combinado(("eclume/gate", "success")))[0] is True
    for estado in ("pending", "failure", "error"):
        liberado, mensagem = gate.decidir(combinado(("eclume/gate", estado)))
        assert liberado is False
        assert estado in mensagem


def test_decidir_recusa_sem_o_gate_mesmo_com_outros_contextos_verdes() -> None:
    """Outro contexto verde, ou a dispensa, não substitui o gate."""
    liberado, mensagem = gate.decidir(combinado(("ci/outra", "success"), ("eclume/gate-dispensa", "failure")))
    assert liberado is False
    assert "ausente" in mensagem


def test_decidir_le_o_mais_recente_por_contexto_do_status_combinado() -> None:
    """O status combinado já traz um por contexto; a dispensa ao lado não atrapalha."""
    assert gate.decidir(combinado(("eclume/gate-dispensa", "failure"), ("eclume/gate", "success")))[0] is True


def test_decidir_pela_linha_de_comando(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """Código de saída 0 só com o gate verde; entrada inválida vale como gate ausente."""
    codigo, saida = rodar(["decidir"], json.dumps(combinado(("eclume/gate", "success"))), monkeypatch, capsys)
    assert codigo == 0
    assert "success" in saida
    codigo, saida = rodar(["decidir"], "não é json", monkeypatch, capsys)
    assert codigo == 1
    assert "ausente" in saida


# --- descricao ------------------------------------------------------------------------------------


def todos(codigo: int = 0) -> dict[str, int]:
    """Os sete pilares com o mesmo código de saída."""
    return dict.fromkeys(gate.PILARES, codigo)


def test_descricao_success_so_com_os_sete_pilares_verdes() -> None:
    """`success` exige os sete pilares com saída 0."""
    estado, texto = gate.descricao(todos(), 125, LOG)
    assert estado == "success"
    assert texto == f"7 pilares verdes · 2min05s · log {LOG}"


def test_descricao_failure_nomeia_os_pilares_que_falharam_na_ordem() -> None:
    """A descrição nomeia os pilares que falharam, na ordem de `--lista`."""
    resultados = todos() | {"windows": 101, "python": 1}
    estado, texto = gate.descricao(resultados, 40, LOG)
    assert estado == "failure"
    assert texto.startswith("falhou: python, windows · 40s")


def test_descricao_error_quando_falta_pilar() -> None:
    """Pilar sem resultado é o gate sem prova: `error`."""
    resultados = todos()
    del resultados["mobile"]
    estado, texto = gate.descricao(resultados, 0, LOG)
    assert estado == "error"
    assert "sem prova: mobile" in texto


def test_descricao_cabe_em_140_caracteres() -> None:
    """O GitHub recusa descrição com mais de 140 caracteres."""
    estado, texto = gate.descricao(todos(1), 3600 * 2, "~/" + "x" * 200)
    assert estado == "failure"
    assert len(texto) <= gate.LIMITE_DESCRICAO
    assert texto.startswith("falhou: python, contracts")


def test_descricao_pela_linha_de_comando(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """Estado na primeira linha e descrição na segunda."""
    entrada = "\n".join(f"{p} 0" for p in gate.PILARES) + "\n"
    codigo, saida = rodar(["descricao", "--duracao", "61", "--log", LOG], entrada, monkeypatch, capsys)
    assert codigo == 0
    assert saida.splitlines() == ["success", f"7 pilares verdes · 1min01s · log {LOG}"]


def test_resultado_invalido_e_recusado() -> None:
    """Pilar desconhecido na entrada é erro, não pilar verde."""
    with pytest.raises(ValueError, match="inválida"):
        gate.ler_resultados(["lumea 0"])


# --- alvos-do-push --------------------------------------------------------------------------------


def test_alvos_do_push_so_main_e_sem_ref_apagada() -> None:
    """Só atualizações de `refs/heads/main` disparam o gate; apagar a ref não dispara."""
    linhas = [
        f"refs/heads/main {SHA} refs/heads/main {'b' * 40}",
        f"refs/heads/plan/1-x {'c' * 40} refs/heads/plan/1-x {gate.SHA_NULO}",
        f"(delete) {gate.SHA_NULO} refs/heads/main {'d' * 40}",
        f"refs/heads/outro {'e' * 40} refs/heads/main {SHA}",
    ]
    assert gate.alvos_do_push(linhas) == [SHA, "e" * 40]


def test_alvos_do_push_pela_linha_de_comando(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Um SHA por linha na saída."""
    codigo, saida = rodar(["alvos-do-push"], f"refs/heads/main {SHA} refs/heads/main {'b' * 40}\n", monkeypatch, capsys)
    assert codigo == 0
    assert saida.split() == [SHA]
