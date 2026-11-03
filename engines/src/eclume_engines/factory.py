"""Engine factory by name, without importing a heavy dependency ahead of time."""

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
    """Engine name outside `ENGINES`."""


def get_engine(name: str | None = None, **kwargs: Any) -> Engine:  # noqa: ANN401 — kwargs passed through to the constructor
    """Instantiate the engine `name` (default `whisperx-local`) with the constructor arguments."""
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
