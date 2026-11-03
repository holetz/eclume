"""Engine `cpu`: faster-whisper `small` with `int8`, for development without a GPU.

No wav2vec2 alignment (word times come from faster-whisper itself) and no diarization: pyannote
would pull torch onto the dev machine. faster-whisper comes from the `cpu` extra and is imported
only when transcribing.
"""

from __future__ import annotations

import importlib
import math
from typing import TYPE_CHECKING, Any

from eclume_engines.base import (
    ASR_FAILED,
    AUDIO_DECODE_FAILED,
    EngineError,
    EngineOptions,
    EngineResult,
    ProgressFn,
    Segment,
    Word,
)

if TYPE_CHECKING:
    from pathlib import Path

DEFAULT_MODEL = "small"
DEFAULT_COMPUTE_TYPE = "int8"
WARN_NO_DIARIZATION = "diarization_unavailable_cpu"


class CpuEngine:
    """CPU ASR with faster-whisper."""

    name = "cpu"

    def __init__(self, *, threads: int = 0) -> None:
        """`threads=0` lets CTranslate2 choose from the number of cores."""
        self.threads = threads
        self._model_key: tuple[str, str] | None = None
        self._model: Any = None

    def unload(self) -> None:
        """Drop the loaded model."""
        self._model = None
        self._model_key = None

    def _load(self, model: str, compute_type: str) -> Any:  # noqa: ANN401 — WhisperModel
        if self._model_key != (model, compute_type):
            faster_whisper = importlib.import_module("faster_whisper")
            self._model = faster_whisper.WhisperModel(
                model, device="cpu", compute_type=compute_type, cpu_threads=self.threads
            )
            self._model_key = (model, compute_type)
        return self._model

    def transcribe(
        self,
        audio_path: Path,
        options: EngineOptions,
        progress: ProgressFn | None = None,
    ) -> EngineResult:
        """Transcribe with word timestamps; a single speaker."""
        model_name = options.model or DEFAULT_MODEL
        compute_type = options.compute_type or DEFAULT_COMPUTE_TYPE
        warnings = [WARN_NO_DIARIZATION] if options.diarize else []
        model = self._load(model_name, compute_type)
        try:
            raw_segments, info = model.transcribe(
                str(audio_path), language=options.language, word_timestamps=True, vad_filter=True
            )
        except Exception as exc:
            raise EngineError(AUDIO_DECODE_FAILED, f"falha ao abrir o áudio: {exc}") from exc

        duration = float(info.duration)
        segments: list[Segment] = []
        try:
            for raw in raw_segments:
                words = [
                    Word(text=w.word.strip(), start=w.start, end=w.end, score=w.probability)
                    for w in raw.words or []
                    if w.word.strip()
                ]
                segments.append(
                    Segment(
                        start=raw.start,
                        end=raw.end,
                        text=raw.text.strip(),
                        words=words,
                        confidence=min(1.0, math.exp(raw.avg_logprob)),
                    )
                )
                if progress is not None and duration > 0:
                    progress("asr", min(100.0, raw.end / duration * 100))
        except Exception as exc:
            raise EngineError(ASR_FAILED, f"falha no ASR: {exc}") from exc

        return EngineResult(
            engine=self.name,
            model=model_name,
            compute_type=compute_type,
            # With no requested language, faster-whisper detects it.
            language=options.language or info.language,
            duration_s=duration,
            segments=segments,
            warnings=warnings,
        )
