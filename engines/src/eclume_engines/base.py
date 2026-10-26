"""Neutral types of the ASR engine interface.

The engine returns an `EngineResult` without knowing the contract schema: the worker converts it
to `transcript.raw.json`. Times here are in seconds (`float`), as in WhisperX.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping
    from pathlib import Path

type ProgressFn = Callable[[str, float], None]
"""Progress callback: `(step, step_pct)`, with step one of `asr`, `align`, `diarize` or `embed`."""

# Error codes an engine may raise; the worker adds the download and upload ones.
AUDIO_DECODE_FAILED = "audio_decode_failed"
OUT_OF_MEMORY = "out_of_memory"
ASR_FAILED = "asr_failed"
ALIGNMENT_FAILED = "alignment_failed"
DIARIZATION_FAILED = "diarization_failed"


class EngineError(Exception):
    """Failure of an engine, with the job contract's `error_code`."""

    def __init__(self, code: str, message: str) -> None:
        """Keep the contract code together with the message."""
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class EngineOptions:
    """Options of a transcription job, coming from `options` of the `transcribe` job."""

    # `None`: the engine detects the language and returns it in `EngineResult.language`.
    language: str | None = "pt"
    model: str | None = None
    compute_type: str | None = None
    diarize: bool = True
    embeddings: bool = True
    min_speakers: int | None = None
    max_speakers: int | None = None
    # From the admin configuration; when empty, the engine defaults apply (and `ECLUME_BATCH_SIZE` in the worker).
    batch_size: int | None = None
    fallback_model: str | None = None
    diarization_model: str | None = None
    # Account terms (people's names) the ASR should favour; they apply to this job only.
    vocabulary: tuple[str, ...] = ()

    @classmethod
    def from_mapping(cls, options: Mapping[str, Any] | None) -> EngineOptions:
        """Build from the job dict, ignoring unknown keys (such as `engine`)."""
        options = options or {}

        def _int(key: str) -> int | None:
            value = options.get(key)
            return None if value is None else int(value)

        # `language: null` asks for detection; without the key (old job), Portuguese applies.
        return cls(
            language=options.get("language", "pt") or None,
            model=options.get("model") or None,
            compute_type=options.get("compute_type") or None,
            diarize=bool(options.get("diarize", True)),
            embeddings=bool(options.get("embeddings", True)),
            min_speakers=_int("min_speakers"),
            max_speakers=_int("max_speakers"),
            batch_size=_int("batch_size"),
            fallback_model=options.get("fallback_model") or None,
            diarization_model=options.get("diarization_model") or None,
            vocabulary=tuple(str(term) for term in options.get("vocabulary") or () if str(term).strip()),
        )


@dataclass
class Word:
    """Timed word; `start`/`end` are `None` when the aligner did not place it."""

    text: str
    start: float | None
    end: float | None
    score: float | None = None
    speaker: str | None = None


@dataclass
class Segment:
    """Continuous speech, with the raw speaker label from diarization (`SPEAKER_00`) or `None`."""

    start: float
    end: float
    text: str
    speaker: str | None = None
    words: list[Word] = field(default_factory=list)
    confidence: float | None = None


@dataclass
class EngineResult:
    """Neutral output of an engine."""

    engine: str
    model: str
    compute_type: str
    # The requested language, or the detected one when the job asked for detection.
    language: str
    duration_s: float
    segments: list[Segment]
    speaker_embeddings: dict[str, list[float]] = field(default_factory=dict)
    align_model: str | None = None
    diarization_model: str | None = None
    embedding_model: str | None = None
    batch_size: int | None = None
    peak_vram_mb: int | None = None
    warnings: list[str] = field(default_factory=list)


class Engine(Protocol):
    """Contract of an ASR engine."""

    name: str

    def transcribe(
        self,
        audio_path: Path,
        options: EngineOptions,
        progress: ProgressFn | None = None,
    ) -> EngineResult:
        """Transcribe the file; raise `EngineError` with the contract code on failure."""
        ...

    def unload(self) -> None:
        """Release the loaded models (VRAM and RAM)."""
        ...


def is_oom(exc: BaseException) -> bool:
    """Recognize a GPU out-of-memory error coming from torch or CTranslate2."""
    return "out of memory" in str(exc).lower()
