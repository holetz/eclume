"""Tipos neutros da interface de engine de ASR.

A engine devolve um `EngineResult` sem conhecer o schema do contrato: quem converte para o
`transcript.raw.json` é o worker. Tempos aqui são em segundos (`float`), como no WhisperX.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping
    from pathlib import Path

type ProgressFn = Callable[[str, float], None]
"""Callback de progresso: `(etapa, pct_da_etapa)`, etapa em `asr`, `align`, `diarize` ou `embed`."""

# Códigos de erro que uma engine pode levantar; o worker acrescenta os de download e upload.
AUDIO_DECODE_FAILED = "audio_decode_failed"
OUT_OF_MEMORY = "out_of_memory"
ASR_FAILED = "asr_failed"
ALIGNMENT_FAILED = "alignment_failed"
DIARIZATION_FAILED = "diarization_failed"


class EngineError(Exception):
    """Falha de uma engine, com o `error_code` do contrato de jobs."""

    def __init__(self, code: str, message: str) -> None:
        """Guarda o código do contrato junto da mensagem."""
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class EngineOptions:
    """Opções de um job de transcrição, vindas de `options` do job `transcribe`."""

    language: str = "pt"
    model: str | None = None
    compute_type: str | None = None
    diarize: bool = True
    embeddings: bool = True
    min_speakers: int | None = None
    max_speakers: int | None = None

    @classmethod
    def from_mapping(cls, options: Mapping[str, Any] | None) -> EngineOptions:
        """Constrói a partir do dict do job, ignorando chaves desconhecidas (como `engine`)."""
        options = options or {}

        def _int(key: str) -> int | None:
            value = options.get(key)
            return None if value is None else int(value)

        return cls(
            language=options.get("language") or "pt",
            model=options.get("model") or None,
            compute_type=options.get("compute_type") or None,
            diarize=bool(options.get("diarize", True)),
            embeddings=bool(options.get("embeddings", True)),
            min_speakers=_int("min_speakers"),
            max_speakers=_int("max_speakers"),
        )


@dataclass
class Word:
    """Palavra com tempo; `start`/`end` são `None` quando o alinhador não a posicionou."""

    text: str
    start: float | None
    end: float | None
    score: float | None = None
    speaker: str | None = None


@dataclass
class Segment:
    """Fala contínua, com o rótulo bruto de locutor da diarização (`SPEAKER_00`) ou `None`."""

    start: float
    end: float
    text: str
    speaker: str | None = None
    words: list[Word] = field(default_factory=list)
    confidence: float | None = None


@dataclass
class EngineResult:
    """Saída neutra de uma engine."""

    engine: str
    model: str
    compute_type: str
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
    """Contrato de uma engine de ASR."""

    name: str

    def transcribe(
        self,
        audio_path: Path,
        options: EngineOptions,
        progress: ProgressFn | None = None,
    ) -> EngineResult:
        """Transcreve o arquivo; levanta `EngineError` com o código do contrato em falha."""
        ...

    def unload(self) -> None:
        """Libera os modelos carregados (VRAM e RAM)."""
        ...


def is_oom(exc: BaseException) -> bool:
    """Reconhece falta de memória de GPU vinda do torch ou do CTranslate2."""
    return "out of memory" in str(exc).lower()
