"""Interface de engine de ASR do eclume.

O núcleo não importa torch, WhisperX nem faster-whisper: cada engine pesada importa as próprias
dependências só ao transcrever, e elas vêm dos extras `whisperx` e `cpu` do pacote.
"""

from importlib.metadata import version

from eclume_engines.base import (
    Engine,
    EngineError,
    EngineOptions,
    EngineResult,
    Segment,
    Word,
)
from eclume_engines.factory import DEFAULT_ENGINE, ENGINES, UnknownEngineError, get_engine

__version__ = version("eclume-engines")

__all__ = [
    "DEFAULT_ENGINE",
    "ENGINES",
    "Engine",
    "EngineError",
    "EngineOptions",
    "EngineResult",
    "Segment",
    "UnknownEngineError",
    "Word",
    "__version__",
    "get_engine",
]
