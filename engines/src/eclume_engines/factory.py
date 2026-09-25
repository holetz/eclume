"""Fábrica de engines por nome, sem importar dependência pesada antes da hora."""

from __future__ import annotations

import importlib
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from eclume_engines.base import Engine

ENGINES: dict[str, str] = {
    "whisperx-local": "eclume_engines.whisperx_local:WhisperXLocalEngine",
    "cpu": "eclume_engines.cpu:CpuEngine",
    "openai-compatible": "eclume_engines.openai_compatible:OpenAICompatibleEngine",
}
DEFAULT_ENGINE = "whisperx-local"


class UnknownEngineError(ValueError):
    """Nome de engine fora de `ENGINES`."""


def get_engine(name: str | None = None, **kwargs: Any) -> Engine:  # noqa: ANN401 — kwargs repassados ao construtor
    """Instancia a engine `name` (padrão `whisperx-local`) com os argumentos do construtor."""
    name = name or DEFAULT_ENGINE
    try:
        target = ENGINES[name]
    except KeyError:
        known = ", ".join(sorted(ENGINES))
        msg = f"engine desconhecida: {name!r} (conhecidas: {known})"
        raise UnknownEngineError(msg) from None
    module_name, _, class_name = target.partition(":")
    cls = getattr(importlib.import_module(module_name), class_name)
    return cls(**kwargs)
