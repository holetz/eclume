"""Engine `whisperx-local`: ASR, alinhamento, diarização e embeddings com o WhisperX na GPU.

O WhisperX (e com ele torch e pyannote) é importado só dentro de `transcribe`, para que o worker
e os testes importem este módulo sem as dependências pesadas. As chamadas seguem a API do
WhisperX 3.8.6, fixado no extra `whisperx`.

Na GTX 1660 (6 GB, Turing, sem tensor cores) há um único modelo residente por vez: carregar o
modelo de uma etapa descarrega o da anterior. O `fp16` puro é recusado (NaN na série 16xx).
"""

from __future__ import annotations

import gc
import importlib
import logging
import statistics
import sys
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from eclume_engines.base import (
    ALIGNMENT_FAILED,
    ASR_FAILED,
    AUDIO_DECODE_FAILED,
    DIARIZATION_FAILED,
    OUT_OF_MEMORY,
    EngineError,
    EngineOptions,
    EngineResult,
    ProgressFn,
    Segment,
    Word,
    is_oom,
)
from eclume_engines.vram import VramMonitor, initial_batch_size

if TYPE_CHECKING:
    from pathlib import Path

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16_000
DEFAULT_MODEL = "large-v3-turbo"
FALLBACK_MODEL = "medium"
DEFAULT_COMPUTE_TYPE = "int8_float16"
# Ordem de recuo quando o backend recusa o compute type pedido (nunca `float16`).
COMPUTE_TYPE_FALLBACKS = ("int8", "float32")
FORBIDDEN_COMPUTE_TYPES = frozenset({"float16"})
DIARIZATION_MODEL = "pyannote/speaker-diarization-community-1"
# Tipo de cada modelo residente, no vocabulário de `models_loaded` do contrato v1.
_KINDS = {"asr": "asr", "align": "alignment", "diarize": "diarization"}
EMBEDDING_MODEL = "pyannote/wespeaker-voxceleb-resnet34-LM"

WARN_NO_TOKEN = "diarization_skipped_no_token"  # noqa: S105 — código de aviso, não segredo
WARN_NO_ACCESS = "diarization_skipped_no_access"
WARN_FALLBACK_MEDIUM = "fallback_medium"
WARN_BATCH_REDUCED = "batch_size_reduced"
WARN_FLOAT16_REJECTED = "compute_type_float16_rejected"
WARN_ALIGN_UNAVAILABLE = "alignment_unavailable"


def _noop(_stage: str, _pct: float) -> None:
    return None


class WhisperXLocalEngine:
    """Pipeline WhisperX num único processo CUDA."""

    name = "whisperx-local"

    def __init__(
        self,
        *,
        hf_token: str | None = None,
        device: str = "cuda",
        vram: VramMonitor | None = None,
        batch_size: int | None = None,
    ) -> None:
        """`hf_token` libera a diarização; sem ele o job transcreve com um locutor só.

        `batch_size` fixa o lote inicial do ASR; `None` o escolhe pela VRAM livre.
        """
        self.hf_token = hf_token
        self.device = device
        self.batch_size = batch_size
        self.vram = vram if vram is not None else VramMonitor()
        self._slot_key: tuple[Any, ...] | None = None
        self._slot: Any = None
        # (tipo, nome, carregado em, VRAM do modelo) do residente; trocado inteiro, lido pelo heartbeat.
        self._resident: tuple[str, str, str, int | None] | None = None

    # -- modelo residente -------------------------------------------------------------------

    def _load(self, key: tuple[Any, ...], loader: Any, name: str) -> Any:  # noqa: ANN401 — objetos do WhisperX
        if self._slot_key != key:
            self.unload()
            before = self.vram.used_mb()
            self._slot = loader()
            self._slot_key = key
            after = self.vram.used_mb()
            vram_mb = max(0, after - before) if before is not None and after is not None else None
            loaded_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
            self._resident = (_KINDS[key[0]], name, loaded_at, vram_mb)
        return self._slot

    def loaded_models(self) -> list[dict[str, Any]]:
        """O modelo residente na GPU (há no máximo um), para o heartbeat do worker."""
        resident = self._resident
        if resident is None:
            return []
        kind, name, loaded_at, vram_mb = resident
        return [{"name": name, "kind": kind, "loaded_at": loaded_at, "vram_mb": vram_mb}]

    def unload(self) -> None:
        """Descarrega o modelo residente e devolve a VRAM ao driver."""
        if self._slot is None:
            return
        self._slot = None
        self._slot_key = None
        self._resident = None
        gc.collect()
        torch = sys.modules.get("torch")
        if torch is not None and torch.cuda.is_available():
            torch.cuda.empty_cache()

    # -- pipeline ---------------------------------------------------------------------------

    def transcribe(
        self,
        audio_path: Path,
        options: EngineOptions,
        progress: ProgressFn | None = None,
    ) -> EngineResult:
        """Roda ASR → alinhamento → diarização/embeddings sobre o arquivo."""
        progress = progress or _noop
        whisperx = importlib.import_module("whisperx")
        warnings: list[str] = []

        try:
            audio = whisperx.load_audio(str(audio_path))
        except Exception as exc:
            raise EngineError(AUDIO_DECODE_FAILED, f"falha ao decodificar o áudio: {exc}") from exc
        duration_s = len(audio) / SAMPLE_RATE

        with self.vram.track() as peak:
            result, model, compute_type, batch_size = self._asr(whisperx, audio, options, progress, warnings)
            progress("asr", 100.0)
            result, align_model = self._align(whisperx, audio, result, options, warnings)
            progress("align", 100.0)
            result, embeddings, diarization_model = self._diarize(whisperx, audio, result, options, progress, warnings)
            progress("diarize", 100.0)

        segments = _to_segments(result.get("segments", []))
        progress("embed", 100.0)
        return EngineResult(
            engine=self.name,
            model=model,
            compute_type=compute_type,
            language=options.language,
            duration_s=duration_s,
            segments=segments,
            speaker_embeddings=embeddings or {},
            align_model=align_model,
            diarization_model=diarization_model,
            embedding_model=EMBEDDING_MODEL if embeddings else None,
            batch_size=batch_size,
            peak_vram_mb=peak.mb,
            warnings=warnings,
        )

    def _compute_types(self, options: EngineOptions, warnings: list[str]) -> list[str]:
        requested = options.compute_type or DEFAULT_COMPUTE_TYPE
        if requested in FORBIDDEN_COMPUTE_TYPES:
            logger.warning("compute_type %s recusado na GTX 16xx; usando %s", requested, DEFAULT_COMPUTE_TYPE)
            warnings.append(WARN_FLOAT16_REJECTED)
            requested = DEFAULT_COMPUTE_TYPE
        return [requested, *(c for c in COMPUTE_TYPE_FALLBACKS if c != requested)]

    def _load_asr(self, whisperx: Any, model: str, compute_types: list[str], language: str) -> tuple[Any, str]:  # noqa: ANN401
        last_error: Exception | None = None
        for compute_type in compute_types:
            try:
                pipeline = self._load(
                    ("asr", model, compute_type, language),
                    lambda ct=compute_type: whisperx.load_model(model, self.device, compute_type=ct, language=language),
                    model,
                )
            except ValueError as exc:  # o CTranslate2 recusa o compute type com ValueError
                logger.warning("compute_type %s indisponível: %s", compute_type, exc)
                last_error = exc
                continue
            return pipeline, compute_type
        raise EngineError(ASR_FAILED, f"nenhum compute_type utilizável: {last_error}")

    def _asr(
        self,
        whisperx: Any,  # noqa: ANN401
        audio: Any,  # noqa: ANN401
        options: EngineOptions,
        progress: ProgressFn,
        warnings: list[str],
    ) -> tuple[dict[str, Any], str, str, int]:
        requested = options.model or DEFAULT_MODEL
        fallback = options.fallback_model or FALLBACK_MODEL
        models = [requested] if requested == fallback else [requested, fallback]
        compute_types = self._compute_types(options, warnings)
        # `ECLUME_BATCH_SIZE` (operador do host) vence o lote da configuração do admin.
        first_batch = self.batch_size or options.batch_size or initial_batch_size(self.vram.free_mb())

        for model in models:
            if model == fallback and model != requested:
                logger.warning("OOM persistente com %s; caindo para %s", requested, fallback)
                warnings.append(WARN_FALLBACK_MEDIUM)
            batch = first_batch
            while True:
                try:
                    pipeline, compute_type = self._load_asr(whisperx, model, compute_types, options.language)
                    result = pipeline.transcribe(
                        audio,
                        batch_size=batch,
                        language=options.language,
                        progress_callback=lambda pct: progress("asr", pct),
                    )
                except EngineError:
                    raise
                except Exception as exc:
                    if not is_oom(exc):
                        raise EngineError(ASR_FAILED, f"falha no ASR: {exc}") from exc
                    self.unload()
                    if batch == 1:
                        break
                    batch = max(1, batch // 2)
                    logger.warning("OOM no ASR (%s); tentando batch_size=%d", model, batch)
                    if WARN_BATCH_REDUCED not in warnings:
                        warnings.append(WARN_BATCH_REDUCED)
                    continue
                return result, model, compute_type, batch
        raise EngineError(OUT_OF_MEMORY, f"VRAM insuficiente mesmo com batch_size=1 e o modelo {fallback}")

    def _align(
        self,
        whisperx: Any,  # noqa: ANN401
        audio: Any,  # noqa: ANN401
        result: dict[str, Any],
        options: EngineOptions,
        warnings: list[str],
    ) -> tuple[dict[str, Any], str | None]:
        try:
            align_model, metadata = self._load(
                ("align", options.language),
                lambda: whisperx.load_align_model(language_code=options.language, device=self.device),
                _align_model_name(options.language) or f"alinhamento ({options.language})",
            )
        except ValueError as exc:  # idioma sem modelo de alinhamento padrão
            logger.warning("sem alinhamento para %s: %s", options.language, exc)
            warnings.append(WARN_ALIGN_UNAVAILABLE)
            return result, None
        except Exception as exc:
            raise _stage_error(ALIGNMENT_FAILED, "alinhamento", exc) from exc
        try:
            aligned = whisperx.align(
                result["segments"], align_model, metadata, audio, self.device, return_char_alignments=False
            )
        except Exception as exc:
            raise _stage_error(ALIGNMENT_FAILED, "alinhamento", exc) from exc
        return aligned, _align_model_name(options.language)

    def _diarize(  # noqa: PLR0913, PLR0917 — etapa do pipeline recebe o estado do job explicitamente
        self,
        whisperx: Any,  # noqa: ANN401
        audio: Any,  # noqa: ANN401
        result: dict[str, Any],
        options: EngineOptions,
        progress: ProgressFn,
        warnings: list[str],
    ) -> tuple[dict[str, Any], dict[str, list[float]] | None, str | None]:
        if not options.diarize:
            return result, None, None
        model_name = options.diarization_model or DIARIZATION_MODEL
        if not self.hf_token:
            logger.warning(
                "sem token do Hugging Face: transcrevendo sem diarização (um locutor). "
                "Defina HF_TOKEN ou ECLUME_HF_TOKEN_FILE e aceite os termos de %s.",
                model_name,
            )
            warnings.append(WARN_NO_TOKEN)
            return result, None, None
        try:
            diarize_module = importlib.import_module("whisperx.diarize")
            pipeline = self._load(
                ("diarize", model_name),
                lambda: diarize_module.DiarizationPipeline(
                    model_name=model_name, token=self.hf_token, device=self.device
                ),
                model_name,
            )
        except Exception as exc:
            if not _is_access_denied(exc):
                raise _stage_error(DIARIZATION_FAILED, "diarização", exc) from exc
            logger.warning(
                "sem acesso a %s com o token atual (termos do modelo não aceitos?): transcrevendo "
                "sem diarização (um locutor). Erro: %s",
                model_name,
                exc,
            )
            warnings.append(WARN_NO_ACCESS)
            return result, None, None
        try:
            output = pipeline(
                audio,
                min_speakers=options.min_speakers,
                max_speakers=options.max_speakers,
                return_embeddings=options.embeddings,
                progress_callback=lambda pct: progress("diarize", pct),
            )
            diarize_df, embeddings = output if options.embeddings else (output, None)
            result = whisperx.assign_word_speakers(diarize_df, result, fill_nearest=True)
        except Exception as exc:
            raise _stage_error(DIARIZATION_FAILED, "diarização", exc) from exc
        return result, embeddings, model_name


def _align_model_name(language: str) -> str | None:
    alignment = importlib.import_module("whisperx.alignment")
    for table in ("DEFAULT_ALIGN_MODELS_HF", "DEFAULT_ALIGN_MODELS_TORCH"):
        name = getattr(alignment, table, {}).get(language)
        if name:
            return name
    return None


_ACCESS_ERROR_NAMES = frozenset({"GatedRepoError", "RepositoryNotFoundError", "HfHubHTTPError"})
_ACCESS_MARKERS = ("401", "403", "gated", "authorized list", "restricted")


def _is_access_denied(exc: BaseException) -> bool:
    """Sem acesso ao modelo gated: token recusado ou termos do modelo não aceitos.

    Num 401/403 o pyannote 4 só imprime o erro e devolve `None` em `Pipeline.from_pretrained`, e
    o WhisperX então falha em `None.to(device)`; os demais casos chegam como erro do
    huggingface_hub.
    """
    seen: BaseException | None = exc
    while seen is not None:
        if type(seen).__name__ in _ACCESS_ERROR_NAMES:
            return True
        message = str(seen).lower()
        if isinstance(seen, AttributeError) and "'nonetype' object has no attribute 'to'" in message:
            return True
        if any(marker in message for marker in _ACCESS_MARKERS):
            return True
        seen = seen.__cause__ or seen.__context__
    return False


def _stage_error(code: str, stage: str, exc: Exception) -> EngineError:
    if is_oom(exc):
        return EngineError(OUT_OF_MEMORY, f"VRAM insuficiente na {stage}: {exc}")
    return EngineError(code, f"falha na {stage}: {exc}")


def _score(value: Any) -> float | None:  # noqa: ANN401
    if value is None:
        return None
    score = float(value)
    return None if score != score else min(1.0, max(0.0, score))  # noqa: PLR0124 — NaN


def _time(value: Any) -> float | None:  # noqa: ANN401
    if value is None:
        return None
    time = float(value)
    return None if time != time else time  # noqa: PLR0124 — NaN


def _to_segments(raw_segments: list[dict[str, Any]]) -> list[Segment]:
    segments: list[Segment] = []
    for raw in raw_segments:
        words = [
            Word(
                text=str(w.get("word", "")).strip(),
                start=_time(w.get("start")),
                end=_time(w.get("end")),
                score=_score(w.get("score")),
                speaker=w.get("speaker"),
            )
            for w in raw.get("words", [])
            if str(w.get("word", "")).strip()
        ]
        scores = [w.score for w in words if w.score is not None]
        segments.append(
            Segment(
                start=float(raw["start"]),
                end=float(raw["end"]),
                text=str(raw.get("text", "")).strip(),
                speaker=raw.get("speaker"),
                words=words,
                confidence=statistics.fmean(scores) if scores else None,
            )
        )
    return segments
