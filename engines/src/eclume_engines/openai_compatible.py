"""Engine `openai-compatible`: cliente de `POST /v1/audio/transcriptions` (speaches, OpenAI).

Pede `response_format=verbose_json` com granularidade de palavra e segmento. O servidor remoto
não diariza, então o resultado tem um locutor só.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

import httpx

from eclume_engines.base import (
    ASR_FAILED,
    EngineError,
    EngineOptions,
    EngineResult,
    ProgressFn,
    Segment,
    Word,
)

if TYPE_CHECKING:
    from pathlib import Path

DEFAULT_MODEL = "Systran/faster-whisper-large-v3"
WARN_NO_DIARIZATION = "diarization_unavailable_remote"
TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions"


class OpenAICompatibleEngine:
    """Delegação do ASR a um servidor OpenAI-compatível."""

    name = "openai-compatible"

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str | None = None,
        default_model: str = DEFAULT_MODEL,
        timeout_s: float = 3600.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        """`base_url` sem o `/v1` (ex.: `http://speaches:8000`)."""
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self.default_model = default_model
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"), headers=headers, timeout=timeout_s, transport=transport
        )

    def unload(self) -> None:
        """Nada a descarregar: o modelo vive no servidor remoto."""

    def transcribe(
        self,
        audio_path: Path,
        options: EngineOptions,
        progress: ProgressFn | None = None,
    ) -> EngineResult:
        """Envia o arquivo e converte o `verbose_json`."""
        model = options.model or self.default_model
        data = {
            "model": model,
            "response_format": "verbose_json",
            "timestamp_granularities[]": ["word", "segment"],
        }
        if options.language:
            # Sem idioma, o servidor detecta e o devolve no `verbose_json`.
            data["language"] = options.language
        try:
            with audio_path.open("rb") as fh:
                response = self._client.post(
                    TRANSCRIPTIONS_PATH, data=data, files={"file": (audio_path.name, fh, "audio/ogg")}
                )
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise EngineError(ASR_FAILED, f"falha no servidor remoto: {exc}") from exc
        if progress is not None:
            progress("asr", 100.0)

        return EngineResult(
            engine=self.name,
            model=model,
            compute_type="remote",
            language=options.language or body.get("language") or "pt",
            duration_s=float(body.get("duration") or 0.0),
            segments=_segments(body),
            warnings=[WARN_NO_DIARIZATION] if options.diarize else [],
        )


def _word(raw: dict[str, Any]) -> Word:
    probability = raw.get("probability")
    return Word(
        text=str(raw.get("word", "")).strip(),
        start=raw.get("start"),
        end=raw.get("end"),
        score=None if probability is None else float(probability),
    )


def _segments(body: dict[str, Any]) -> list[Segment]:
    segments: list[Segment] = []
    for raw in body.get("segments") or []:
        logprob = raw.get("avg_logprob")
        segments.append(
            Segment(
                start=float(raw["start"]),
                end=float(raw["end"]),
                text=str(raw.get("text", "")).strip(),
                words=[_word(w) for w in raw.get("words") or [] if str(w.get("word", "")).strip()],
                confidence=None if logprob is None else min(1.0, math.exp(float(logprob))),
            )
        )
    # A API da OpenAI devolve as palavras no topo, não dentro de cada segmento; o speaches pode
    # devolver as duas formas, e aí valem as de dentro.
    if any(s.words for s in segments):
        return segments
    for raw in body.get("words") or []:
        if not str(raw.get("word", "")).strip() or not segments:
            continue
        word = _word(raw)
        middle = ((word.start or 0.0) + (word.end or word.start or 0.0)) / 2
        target = next((s for s in segments if s.start <= middle <= s.end), None)
        target = target or min(segments, key=lambda s: abs(s.start - middle))
        target.words.append(word)
    return segments
