# ruff: noqa: INP001, S101, D103  # testes soltos dos scripts de deploy; deploy/ não é pacote Python
"""O smoke escolhe o provider do resumo sem cadastrar nenhum (holetz/eclume#129)."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import pytest

_spec = importlib.util.spec_from_file_location("smoke_prod", Path(__file__).with_name("smoke_prod.py"))
assert _spec is not None
assert _spec.loader is not None
smoke = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smoke)


def provider(pid: str, kind: str = "ollama", *, enabled: bool = True, used_for: tuple[str, ...] = ()) -> dict[str, Any]:
    return {"id": pid, "name": pid, "kind": kind, "model": "m", "enabled": enabled, "used_for": list(used_for)}


def test_prefere_o_que_declara_summaries_de_qualquer_kind() -> None:
    items = [
        provider("livre"),
        provider("chat", used_for=("chat",)),
        provider("res", "openai-compatible", used_for=("summaries",)),
    ]
    assert smoke.choose_provider(items)["id"] == "res"


def test_sem_ninguem_declarando_usa_o_habilitado_sem_finalidade() -> None:
    items = [provider("off", enabled=False), provider("chat", used_for=("chat",)), provider("livre", "anthropic")]
    assert smoke.choose_provider(items)["id"] == "livre"


def test_desabilitado_de_summaries_nao_conta() -> None:
    items = [provider("res", enabled=False, used_for=("summaries",)), provider("livre")]
    assert smoke.choose_provider(items)["id"] == "livre"


def test_provider_pedido_ganha_da_finalidade() -> None:
    items = [provider("res", used_for=("summaries",)), provider("outro", "claude-cli", used_for=("chat",))]
    assert smoke.choose_provider(items, "outro")["id"] == "outro"


@pytest.mark.parametrize(
    ("items", "wanted", "mensagem"),
    [
        ([], None, "cadastre um no painel"),
        ([provider("chat", used_for=("chat",))], None, "cadastre um no painel"),
        ([provider("res", used_for=("summaries",))], "x", "não existe"),
        ([provider("off", enabled=False)], "off", "desabilitado"),
    ],
)
def test_nenhum_serve_diz_o_que_fazer(items: list[dict[str, Any]], wanted: str | None, mensagem: str) -> None:
    with pytest.raises(ValueError, match=mensagem):
        smoke.choose_provider(items, wanted)
