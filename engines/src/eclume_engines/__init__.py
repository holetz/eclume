"""ASR engine interface of eclume.

The core does not import torch, WhisperX or faster-whisper: each heavy engine imports its own
dependencies only when transcribing, and they come from the package's `whisperx` and `cpu` extras.
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
