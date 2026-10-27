"""Engine `whisperx-local`: ASR, alignment, diarization and embeddings with WhisperX on the GPU.

WhisperX (and with it torch and pyannote) is imported only inside `transcribe`, so the worker and
the tests can import this module without the heavy dependencies. The calls follow the WhisperX
3.8.6 API, pinned in the `whisperx` extra.

On the GTX 1660 (6 GB, Turing, no tensor cores) there are two slots for models: the ASR one and
the stage one (alignment or diarization). The ASR stays resident between jobs — which saves ~20 s
of loading on each short job — while the free VRAM allows: before loading a stage model, with fewer
than `resident_min_free_mb` free, the ASR is unloaded; an OOM in a stage with the ASR resident
unloads it and repeats the stage once. At the end of the job the stage model leaves and the ASR
stays, until the worker's idle unload. `keep_asr_resident=False` goes back to the single slot
(loading a stage model unloads the previous one). Plain `fp16` is refused (NaN on the 16xx series).
"""

from __future__ import annotations

import dataclasses
import gc
import importlib
import logging
import statistics
import sys
import traceback
from contextlib import contextmanager
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
    from collections.abc import Callable, Iterator
    from pathlib import Path

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16_000
DEFAULT_MODEL = "large-v3-turbo"
FALLBACK_MODEL = "medium"
DEFAULT_COMPUTE_TYPE = "int8_float16"
# Fallback order when the backend refuses the requested compute type (never `float16`).
COMPUTE_TYPE_FALLBACKS = ("int8", "float32")
FORBIDDEN_COMPUTE_TYPES = frozenset({"float16"})
DIARIZATION_MODEL = "pyannote/speaker-diarization-community-1"
# Kind of each resident model, in the `models_loaded` vocabulary of contract v1.
_KINDS = {"asr": "asr", "align": "alignment", "diarize": "diarization"}
# Minimum free VRAM, with the ASR loaded, for it to stay resident when loading a stage: the
# aligner (~0.6 GB) or pyannote (~1 GB) plus their inference, with headroom for Jellyfin.
RESIDENT_MIN_FREE_MB = 2500
EMBEDDING_MODEL = "pyannote/wespeaker-voxceleb-resnet34-LM"

WARN_NO_TOKEN = "diarization_skipped_no_token"  # noqa: S105 — warning code, not a secret
WARN_NO_ACCESS = "diarization_skipped_no_access"
WARN_FALLBACK_MEDIUM = "fallback_medium"
WARN_BATCH_REDUCED = "batch_size_reduced"
WARN_FLOAT16_REJECTED = "compute_type_float16_rejected"
WARN_ALIGN_UNAVAILABLE = "alignment_unavailable"


@contextmanager
def _hotwords(pipeline: Any, vocabulary: tuple[str, ...]) -> Iterator[None]:  # noqa: ANN401 — WhisperX pipeline
    """The account terms as the ASR's `hotwords`, only during the transcription.

    WhisperX reads `pipeline.options` on every call, so the resident model does not reload; the
    original options come back on exit (even on error), and one account's term never reaches the next.
    """
    original = getattr(pipeline, "options", None)
    if not vocabulary or original is None or not dataclasses.is_dataclass(original):
        yield
        return
    pipeline.options = dataclasses.replace(original, hotwords=" ".join(vocabulary))
    try:
        yield
    finally:
        pipeline.options = original


def _noop(_stage: str, _pct: float) -> None:
    return None


class WhisperXLocalEngine:
    """WhisperX pipeline in a single CUDA process."""

    name = "whisperx-local"

    def __init__(  # noqa: PLR0913 — engine options, all named
        self,
        *,
        hf_token: str | None = None,
        device: str = "cuda",
        vram: VramMonitor | None = None,
        batch_size: int | None = None,
        keep_asr_resident: bool = True,
        resident_min_free_mb: int = RESIDENT_MIN_FREE_MB,
    ) -> None:
        """`hf_token` enables diarization; without it the job transcribes with a single speaker.

        `batch_size` fixes the ASR's initial batch; `None` picks it from the free VRAM.
        `keep_asr_resident` keeps the ASR loaded between stages and between jobs, while
        `resident_min_free_mb` is free; `False` is the former single slot.
        """
        self.hf_token = hf_token
        self.device = device
        self.batch_size = batch_size
        self.keep_asr_resident = keep_asr_resident
        self.resident_min_free_mb = resident_min_free_mb
        self.vram = vram if vram is not None else VramMonitor()
        # One slot per role ("asr" and "stage"): {role: (key, object, (kind, name, loaded at, VRAM))}.
        # Replaced by whole assignment: the heartbeat reads it from another thread.
        self._slots: dict[str, tuple[tuple[Any, ...], Any, tuple[str, str, str, int | None]]] = {}

    # -- resident model -------------------------------------------------------------------

    def _load(self, key: tuple[Any, ...], loader: Any, name: str) -> Any:  # noqa: ANN401 — WhisperX objects
        role = "asr" if key[0] == "asr" else "stage"
        current = self._slots.get(role)
        if current is not None and current[0] == key:
            return current[1]
        self._unload_role(role)
        if role == "asr" or not self.keep_asr_resident:
            # Single slot: the new model evicts the other. The ASR also evicts the stage, which is no longer used.
            self._unload_role("stage" if role == "asr" else "asr")
        elif not self._room_for_stage():
            logger.info("Free VRAM below %d MB: unloading the resident ASR", self.resident_min_free_mb)
            self._unload_role("asr")
        before = self.vram.used_mb()
        model = loader()
        after = self.vram.used_mb()
        vram_mb = max(0, after - before) if before is not None and after is not None else None
        loaded_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        self._slots = {**self._slots, role: (key, model, (_KINDS[key[0]], name, loaded_at, vram_mb))}
        return model

    def _room_for_stage(self) -> bool:
        """Does a stage model fit with the ASR resident? Without NVML (no measure), it fits."""
        free = self.vram.free_mb()
        return free is None or free >= self.resident_min_free_mb

    def _unload_role(self, role: str) -> bool:
        if role not in self._slots:
            return False
        self._slots = {r: slot for r, slot in self._slots.items() if r != role}
        gc.collect()
        torch = sys.modules.get("torch")
        if torch is not None and torch.cuda.is_available():
            torch.cuda.empty_cache()
        return True

    def loaded_models(self) -> list[dict[str, Any]]:
        """The models resident on the GPU (the ASR and the stage one, at most), for the worker heartbeat."""
        return [
            {"name": name, "kind": kind, "loaded_at": loaded_at, "vram_mb": vram_mb}
            for _key, _model, (kind, name, loaded_at, vram_mb) in self._slots.values()
        ]

    def unload(self) -> None:
        """Unload every resident model and give the VRAM back to the driver."""
        self._unload_role("stage")
        self._unload_role("asr")

    def _stage(self, run: Callable[[], Any]) -> Any:  # noqa: ANN401 — the stage result
        """Run a stage; on an OOM with the ASR resident, unload the ASR and repeat once."""
        try:
            return run()
        except EngineError as exc:
            if exc.code != OUT_OF_MEMORY or "asr" not in self._slots:
                raise
        # Outside the `except`: `exc` is already gone and does not hold the stage frame with the model that blew up.
        logger.warning("OOM in the stage with the ASR resident; repeating without it")
        self._unload_role("stage")
        self._unload_role("asr")
        return run()

    # -- pipeline ---------------------------------------------------------------------------

    def transcribe(
        self,
        audio_path: Path,
        options: EngineOptions,
        progress: ProgressFn | None = None,
    ) -> EngineResult:
        """Run ASR → alignment → diarization/embeddings over the file."""
        progress = progress or _noop
        whisperx = importlib.import_module("whisperx")
        warnings: list[str] = []

        try:
            audio = whisperx.load_audio(str(audio_path))
        except Exception as exc:
            raise EngineError(AUDIO_DECODE_FAILED, f"falha ao decodificar o áudio: {exc}") from exc
        duration_s = len(audio) / SAMPLE_RATE

        try:
            with self.vram.track() as peak:
                result, model, compute_type, batch_size = self._asr(whisperx, audio, options, progress, warnings)
                progress("asr", 100.0)
                # With no requested language, WhisperX detects it; the aligner is the one for the detected language.
                options = dataclasses.replace(options, language=options.language or result.get("language") or "pt")
                aligned, align_model = self._stage(lambda: self._align(whisperx, audio, result, options, warnings))
                progress("align", 100.0)
                result, embeddings, diarization_model = self._stage(
                    lambda: self._diarize(whisperx, audio, aligned, options, progress, warnings)
                )
                progress("diarize", 100.0)
        except BaseException as exc:
            # The in-flight failure still holds the frames of `_align`/`_diarize` with the stage model.
            _clear_frames(exc)
            raise
        finally:
            if self.keep_asr_resident:
                # The ASR stays for the next job; the stage's VRAM goes back to the host, on success or failure.
                self._unload_role("stage")

        segments = _to_segments(result.get("segments", []))
        progress("embed", 100.0)
        return EngineResult(
            engine=self.name,
            model=model,
            compute_type=compute_type,
            language=options.language or "pt",
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
            logger.warning("compute_type %s refused on the GTX 16xx; using %s", requested, DEFAULT_COMPUTE_TYPE)
            warnings.append(WARN_FLOAT16_REJECTED)
            requested = DEFAULT_COMPUTE_TYPE
        return [requested, *(c for c in COMPUTE_TYPE_FALLBACKS if c != requested)]

    def _load_asr(self, whisperx: Any, model: str, compute_types: list[str], language: str | None) -> tuple[Any, str]:  # noqa: ANN401
        last_error: Exception | None = None
        for compute_type in compute_types:
            try:
                pipeline = self._load(
                    ("asr", model, compute_type, language),
                    lambda ct=compute_type: whisperx.load_model(model, self.device, compute_type=ct, language=language),
                    model,
                )
            except ValueError as exc:  # CTranslate2 refuses the compute type with ValueError
                logger.warning("compute_type %s unavailable: %s", compute_type, exc)
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
        # `ECLUME_BATCH_SIZE` (host operator) wins over the admin configuration's batch.
        first_batch = self.batch_size or options.batch_size or initial_batch_size(self.vram.free_mb())

        for model in models:
            if model == fallback and model != requested:
                logger.warning("Persistent OOM with %s; falling back to %s", requested, fallback)
                warnings.append(WARN_FALLBACK_MEDIUM)
            batch = first_batch
            while True:
                pipeline = None  # `_load_asr` can also blow up: no model from the previous round survives
                try:
                    pipeline, compute_type = self._load_asr(whisperx, model, compute_types, options.language)
                    with _hotwords(pipeline, options.vocabulary):
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
                else:
                    return result, model, compute_type, batch
                # Only the OOM gets here, already outside the `except`: the traceback died with `exc` and does not hold the model.
                pipeline = None
                self.unload()
                if batch == 1:
                    break
                batch = max(1, batch // 2)
                logger.warning("OOM in the ASR (%s); trying batch_size=%d", model, batch)
                if WARN_BATCH_REDUCED not in warnings:
                    warnings.append(WARN_BATCH_REDUCED)
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
        except ValueError as exc:  # language with no default alignment model
            logger.warning("no alignment for %s: %s", options.language, exc)
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

    def _diarize(  # noqa: PLR0913, PLR0917 — pipeline stage receives the job state explicitly
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
                "no Hugging Face token: transcribing without diarization (a single speaker). "
                "Set HF_TOKEN or ECLUME_HF_TOKEN_FILE and accept the terms of %s.",
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
                "no access to %s with the current token (model terms not accepted?): transcribing "
                "without diarization (a single speaker). Error: %s",
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
    """No access to the gated model: token refused or model terms not accepted.

    On a 401/403 pyannote 4 only prints the error and returns `None` from `Pipeline.from_pretrained`,
    and WhisperX then fails on `None.to(device)`; the other cases arrive as a huggingface_hub error.
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


def _clear_frames(exc: BaseException) -> None:
    """Release the locals of the frames in the exception chain (the stage model among them); the traceback stays readable."""
    pending: list[BaseException | None] = [exc]
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if current is None or id(current) in seen:
            continue
        seen.add(id(current))
        traceback.clear_frames(current.__traceback__)
        pending += [current.__cause__, current.__context__]


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
