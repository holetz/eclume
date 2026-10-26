"""Engine `whisperx-local` over a fake `whisperx` module: the shape of the calls and the rules."""

from __future__ import annotations

import dataclasses
import sys
import types
import weakref
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

from eclume_engines import EngineOptions, get_engine
from eclume_engines.base import EngineError
from eclume_engines.hf_token import resolve_hf_token
from eclume_engines.vram import PeakVram, initial_batch_size
from eclume_engines.whisperx_local import (
    DIARIZATION_MODEL,
    EMBEDDING_MODEL,
    WARN_BATCH_REDUCED,
    WARN_FALLBACK_MEDIUM,
    WARN_FLOAT16_REJECTED,
    WARN_NO_ACCESS,
    WARN_NO_TOKEN,
    WhisperXLocalEngine,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

AUDIO = Path("/tmp/audio.ogg")  # noqa: S108 — the fake does not open the file


class FakeAudio:
    """Only the `len` of the samples array matters to the engine."""

    def __init__(self, samples: int) -> None:
        self.samples = samples

    def __len__(self) -> int:
        return self.samples


class FakeVram:
    def __init__(self, free: int | None = 6000) -> None:
        self.free = free
        self.used = [400, 2610, 2610, 3250, 3250, 4230]  # before/after each load: ASR, aligner, pyannote

    def free_mb(self) -> int | None:
        return self.free

    def used_mb(self) -> int | None:
        return self.used.pop(0) if self.free is not None and self.used else None

    @contextmanager
    def track(self) -> Iterator[PeakVram]:
        peak = PeakVram(baseline=300)
        yield peak
        peak.observe(2800)


class FakeAlignModel:
    """Class instance: `object()` does not accept `weakref`."""


@dataclasses.dataclass(frozen=True)
class FakeAsrOptions:
    hotwords: str | None = None


class FakeWhisperX:
    """Record the calls; `oom_batches` defines the batches that run out of memory."""

    def __init__(self, oom_batches: set[int] | None = None, oom_models: set[str] | None = None) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.oom_batches = oom_batches or set()
        self.oom_models = oom_models or set()
        self.hotwords: list[str | None] = []  # the hotwords the ASR saw in each transcribe
        self.models: list[tuple[str, weakref.ref]] = []  # (role, weak reference) of each model created

    def track(self, kind: str, model: Any) -> Any:
        self.models.append((kind, weakref.ref(model)))
        return model

    def alive(self) -> list[str]:
        return [kind for kind, ref in self.models if ref() is not None]

    def module(self) -> types.ModuleType:
        mod = types.ModuleType("whisperx")
        mod.load_audio = self.load_audio
        mod.load_model = self.load_model
        mod.load_align_model = self.load_align_model
        mod.align = self.align
        mod.assign_word_speakers = self.assign_word_speakers
        return mod

    def load_audio(self, path: str) -> FakeAudio:
        self.calls.append(("load_audio", path))
        return FakeAudio(16_000 * 90)

    def load_model(self, model: str, device: str, *, compute_type: str, language: str | None) -> Any:
        self.calls.append(("load_model", (model, device, compute_type, language)))
        fake = self

        class Pipeline:
            options = FakeAsrOptions()

            def transcribe(self, audio: Any, *, batch_size: int, language: str | None, progress_callback: Any) -> dict:
                fake.calls.append(("transcribe", (model, batch_size, language)))
                fake.hotwords.append(self.options.hotwords)
                if model in fake.oom_models or batch_size in fake.oom_batches:
                    msg = "CUDA failed with error out of memory"
                    raise RuntimeError(msg)
                progress_callback(50.0)
                return {
                    "segments": [
                        {"start": 0.0, "end": 2.0, "text": " Olá, tudo bem?"},
                        {"start": 2.5, "end": 4.0, "text": " Tudo ótimo."},
                    ],
                    # With no requested language, WhisperX returns the detected one.
                    "language": language or "en",
                }

        return self.track("asr", Pipeline())

    def load_align_model(self, *, language_code: str, device: str) -> tuple[Any, dict]:
        self.calls.append(("load_align_model", (language_code, device)))
        return self.track("alignment", FakeAlignModel()), {
            "language": language_code,
            "dictionary": {},
            "type": "huggingface",
        }

    def align(self, segments: list, model: Any, metadata: dict, audio: Any, device: str, **kw: Any) -> dict:
        self.calls.append(("align", kw))
        return {
            "segments": [
                {
                    "start": 0.1,
                    "end": 1.9,
                    "text": " Olá, tudo bem?",
                    "words": [
                        {"word": "Olá,", "start": 0.1, "end": 0.5, "score": 0.9},
                        {"word": "tudo", "start": 0.6, "end": 1.0, "score": 0.8},
                        {"word": "bem?", "start": 1.1, "end": 1.9, "score": 0.7},
                    ],
                },
                {
                    "start": 2.5,
                    "end": 4.0,
                    "text": " Tudo ótimo.",
                    "words": [
                        {"word": "Tudo", "start": 2.5, "end": 2.9, "score": 0.95},
                        {"word": "2026", "start": None, "end": None},
                        {"word": "ótimo.", "start": 3.0, "end": 4.0, "score": float("nan")},
                    ],
                },
            ]
        }

    def assign_word_speakers(self, diarize_df: Any, result: dict, *, fill_nearest: bool) -> dict:
        self.calls.append(("assign_word_speakers", fill_nearest))
        for seg, speaker in zip(result["segments"], ["SPEAKER_01", "SPEAKER_00"], strict=True):
            seg["speaker"] = speaker
        return result

    def diarize_module(self) -> types.ModuleType:
        fake = self
        mod = types.ModuleType("whisperx.diarize")

        class DiarizationPipeline:
            def __init__(self, *, model_name: str, token: str, device: str) -> None:
                fake.calls.append(("DiarizationPipeline", (model_name, token, device)))
                fake.track("diarization", self)

            def __call__(self, audio: Any, **kw: Any) -> Any:
                fake.calls.append(("diarize", kw))
                kw["progress_callback"](100.0)
                df = "diarize_df"
                if kw["return_embeddings"]:
                    return df, {"SPEAKER_00": [0.1, 0.2], "SPEAKER_01": [0.3, 0.4]}
                return df

        mod.DiarizationPipeline = DiarizationPipeline
        return mod

    def names(self) -> list[str]:
        return [name for name, _ in self.calls]


class EmptyCacheSpy:
    """Fake `torch`: on each `empty_cache`, note which models created by `source` are still alive."""

    def __init__(self) -> None:
        self.source: FakeWhisperX | None = None
        self.snapshots: list[tuple[str, ...]] = []

    def empty_cache(self) -> None:
        self.snapshots.append(tuple(self.source.alive()) if self.source else ())


@pytest.fixture
def spy(monkeypatch: pytest.MonkeyPatch) -> EmptyCacheSpy:
    spy = EmptyCacheSpy()
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: True, empty_cache=spy.empty_cache)
    monkeypatch.setitem(sys.modules, "torch", torch)
    return spy


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeWhisperX:
    fake = FakeWhisperX()
    install(monkeypatch, fake)
    return fake


def install(monkeypatch: pytest.MonkeyPatch, fake: FakeWhisperX) -> None:
    alignment = types.ModuleType("whisperx.alignment")
    alignment.DEFAULT_ALIGN_MODELS_HF = {"pt": "jonatasgrosman/wav2vec2-large-xlsr-53-portuguese"}
    monkeypatch.setitem(sys.modules, "whisperx", fake.module())
    monkeypatch.setitem(sys.modules, "whisperx.diarize", fake.diarize_module())
    monkeypatch.setitem(sys.modules, "whisperx.alignment", alignment)


def engine(token: str | None = "hf_x", free: int | None = 6000) -> WhisperXLocalEngine:
    return WhisperXLocalEngine(hf_token=token, device="cuda", vram=FakeVram(free))


def test_factory_returns_the_whisperx_engine():
    assert get_engine("whisperx-local", vram=FakeVram()).name == "whisperx-local"


def test_full_pipeline_with_diarization_and_embeddings(fake: FakeWhisperX):
    stages: list[tuple[str, float]] = []
    result = engine().transcribe(
        AUDIO, EngineOptions(min_speakers=2, max_speakers=3), lambda s, p: stages.append((s, p))
    )

    assert fake.names() == [
        "load_audio",
        "load_model",
        "transcribe",
        "load_align_model",
        "align",
        "DiarizationPipeline",
        "diarize",
        "assign_word_speakers",
    ]
    assert ("load_model", ("large-v3-turbo", "cuda", "int8_float16", "pt")) in fake.calls
    assert ("DiarizationPipeline", (DIARIZATION_MODEL, "hf_x", "cuda")) in fake.calls
    diarize_kw = dict(fake.calls)["diarize"]
    assert diarize_kw["min_speakers"] == 2
    assert diarize_kw["max_speakers"] == 3
    assert diarize_kw["return_embeddings"] is True
    assert dict(fake.calls)["assign_word_speakers"] is True

    assert result.model == "large-v3-turbo"
    assert result.compute_type == "int8_float16"
    assert result.batch_size == 4
    assert result.duration_s == 90.0
    assert result.align_model == "jonatasgrosman/wav2vec2-large-xlsr-53-portuguese"
    assert result.diarization_model == DIARIZATION_MODEL
    assert result.embedding_model == EMBEDDING_MODEL
    assert result.speaker_embeddings == {"SPEAKER_00": [0.1, 0.2], "SPEAKER_01": [0.3, 0.4]}
    assert result.peak_vram_mb == 2500
    assert result.warnings == []

    first, second = result.segments
    assert first.speaker == "SPEAKER_01"
    assert first.text == "Olá, tudo bem?"
    assert [w.text for w in first.words] == ["Olá,", "tudo", "bem?"]
    assert first.confidence == pytest.approx(0.8)
    assert second.words[1].start is None
    assert second.words[2].score is None  # NaN becomes absence
    assert [s for s, _ in stages] == ["asr", "asr", "align", "diarize", "diarize", "embed"]


def test_without_token_degrades_to_one_speaker(fake: FakeWhisperX):
    result = engine(token=None).transcribe(AUDIO, EngineOptions())
    assert "DiarizationPipeline" not in fake.names()
    assert result.warnings == [WARN_NO_TOKEN]
    assert result.speaker_embeddings == {}
    assert result.diarization_model is None
    assert result.embedding_model is None
    assert all(s.speaker is None for s in result.segments)


def test_without_requested_diarization_no_warning(fake: FakeWhisperX):
    result = engine(token=None).transcribe(AUDIO, EngineOptions(diarize=False))
    assert result.warnings == []
    assert "DiarizationPipeline" not in fake.names()


def test_diarization_without_embeddings(fake: FakeWhisperX):
    result = engine().transcribe(AUDIO, EngineOptions(embeddings=False))
    assert dict(fake.calls)["diarize"]["return_embeddings"] is False
    assert result.speaker_embeddings == {}
    assert result.embedding_model is None
    assert result.diarization_model == DIARIZATION_MODEL


def test_oom_halves_the_batch(monkeypatch: pytest.MonkeyPatch):
    fake = FakeWhisperX(oom_batches={4, 2})
    install(monkeypatch, fake)
    result = engine().transcribe(AUDIO, EngineOptions(diarize=False))
    batches = [args[1] for name, args in fake.calls if name == "transcribe"]
    assert batches == [4, 2, 1]
    assert result.batch_size == 1
    assert result.warnings == [WARN_BATCH_REDUCED]


@pytest.mark.parametrize(
    ("kwargs", "free"),
    [({"oom_batches": {4}}, 6000), ({"oom_models": {"large-v3-turbo"}}, 3000)],
    ids=["halve-the-batch", "fall-back-to-medium"],
)
def test_oom_in_the_asr_frees_the_model_before_the_reload(
    monkeypatch: pytest.MonkeyPatch, spy: EmptyCacheSpy, kwargs: dict, free: int
):
    fake = FakeWhisperX(**kwargs)
    spy.source = fake
    install(monkeypatch, fake)
    engine(free=free).transcribe(AUDIO, EngineOptions(diarize=False))
    # Each ASR that blew up leaves an `empty_cache`; in it the model is already unreachable.
    retreats = sum(kind == "asr" for kind, _ in fake.models) - 1
    assert retreats >= 1
    assert all("asr" not in alive for alive in spy.snapshots[:retreats]), spy.snapshots


def test_fixed_batch_in_the_constructor(fake: FakeWhisperX):
    eng = WhisperXLocalEngine(hf_token=None, vram=FakeVram(6000), batch_size=4)
    assert eng.transcribe(AUDIO, EngineOptions(diarize=False)).batch_size == 4


def test_persistent_oom_falls_back_to_medium(monkeypatch: pytest.MonkeyPatch):
    fake = FakeWhisperX(oom_models={"large-v3-turbo"})
    install(monkeypatch, fake)
    result = engine(free=3000).transcribe(AUDIO, EngineOptions(diarize=False))
    transcribes = [args[:2] for name, args in fake.calls if name == "transcribe"]
    assert transcribes == [("large-v3-turbo", 2), ("large-v3-turbo", 1), ("medium", 2)]
    assert result.model == "medium"
    assert result.warnings == [WARN_BATCH_REDUCED, WARN_FALLBACK_MEDIUM]


def test_oom_even_on_medium_fails_with_out_of_memory(monkeypatch: pytest.MonkeyPatch):
    fake = FakeWhisperX(oom_models={"large-v3-turbo", "medium"})
    install(monkeypatch, fake)
    with pytest.raises(EngineError) as info:
        engine(free=1000).transcribe(AUDIO, EngineOptions(diarize=False))
    assert info.value.code == "out_of_memory"


def test_float16_is_refused(fake: FakeWhisperX):
    result = engine().transcribe(AUDIO, EngineOptions(compute_type="float16", diarize=False))
    assert result.compute_type == "int8_float16"
    assert result.warnings == [WARN_FLOAT16_REJECTED]


def test_compute_type_refused_by_the_backend_falls_back_to_int8(monkeypatch: pytest.MonkeyPatch):
    fake = FakeWhisperX()
    original = fake.load_model

    def load_model(model: str, device: str, *, compute_type: str, language: str) -> Any:
        if compute_type == "int8_float16":
            msg = "Requested int8_float16 compute type, but the target device does not support it"
            raise ValueError(msg)
        return original(model, device, compute_type=compute_type, language=language)

    fake.load_model = load_model
    install(monkeypatch, fake)
    result = engine().transcribe(AUDIO, EngineOptions(diarize=False))
    assert result.compute_type == "int8"


def test_decode_error(monkeypatch: pytest.MonkeyPatch, fake: FakeWhisperX):
    def boom(_path: str) -> None:
        msg = "ffmpeg: invalid data"
        raise RuntimeError(msg)

    monkeypatch.setattr(sys.modules["whisperx"], "load_audio", boom)
    with pytest.raises(EngineError) as info:
        engine().transcribe(AUDIO, EngineOptions())
    assert info.value.code == "audio_decode_failed"


def test_diarization_failure_with_a_token_fails_the_job(monkeypatch: pytest.MonkeyPatch, fake: FakeWhisperX):
    original = sys.modules["whisperx.diarize"].DiarizationPipeline

    class Boom(original):
        def __call__(self, audio: Any, **kw: Any) -> Any:
            msg = "shape mismatch in segmentation"
            raise RuntimeError(msg)

    monkeypatch.setattr(sys.modules["whisperx.diarize"], "DiarizationPipeline", Boom)
    with pytest.raises(EngineError) as info:
        engine().transcribe(AUDIO, EngineOptions())
    assert info.value.code == "diarization_failed"


@pytest.mark.parametrize(
    "error",
    [
        AttributeError("'NoneType' object has no attribute 'to'"),  # pyannote 4 returns None on a 403
        RuntimeError("403 Client Error: Cannot access gated repo. Not in the authorized list."),
        type("GatedRepoError", (Exception,), {})("access denied"),
    ],
)
def test_without_access_to_the_gated_model_degrades(monkeypatch: pytest.MonkeyPatch, fake: FakeWhisperX, error: Exception):
    class NoAccess:
        def __init__(self, **_kw: Any) -> None:
            raise error

    monkeypatch.setattr(sys.modules["whisperx.diarize"], "DiarizationPipeline", NoAccess)
    result = engine().transcribe(AUDIO, EngineOptions())
    assert result.warnings == [WARN_NO_ACCESS]
    assert result.diarization_model is None
    assert result.speaker_embeddings == {}
    assert all(s.speaker is None for s in result.segments)


def test_asr_stays_resident_between_jobs_and_the_stage_leaves(fake: FakeWhisperX):
    eng = engine()
    eng.transcribe(AUDIO, EngineOptions())
    assert [m["kind"] for m in eng.loaded_models()] == ["asr"]
    eng.transcribe(AUDIO, EngineOptions())
    # The second job does not reload the ASR; the aligner and pyannote come back on each job.
    assert fake.names().count("load_model") == 1
    assert fake.names().count("load_align_model") == 2
    assert fake.names().count("DiarizationPipeline") == 2
    eng.unload()
    assert eng.loaded_models() == []


def test_tight_vram_unloads_the_asr_before_the_stage(fake: FakeWhisperX):
    eng = engine(free=1500)
    eng.transcribe(AUDIO, EngineOptions())
    eng.transcribe(AUDIO, EngineOptions())
    assert fake.names().count("load_model") == 2
    assert eng.loaded_models() == []


def test_single_slot_as_before(fake: FakeWhisperX):
    eng = WhisperXLocalEngine(hf_token="hf_x", device="cuda", vram=FakeVram(), keep_asr_resident=False)
    eng.transcribe(AUDIO, EngineOptions())
    assert [m["kind"] for m in eng.loaded_models()] == ["diarization"]
    eng.transcribe(AUDIO, EngineOptions())
    assert fake.names().count("load_model") == 2


def test_oom_in_the_stage_with_resident_asr_unloads_and_repeats(monkeypatch: pytest.MonkeyPatch, fake: FakeWhisperX):
    eng = engine()
    tries = []
    original = fake.align

    def align_oom_once(*args: Any, **kw: Any) -> dict:
        tries.append([m["kind"] for m in eng.loaded_models()])
        if len(tries) == 1:
            msg = "CUDA out of memory"
            raise RuntimeError(msg)
        return original(*args, **kw)

    monkeypatch.setattr(sys.modules["whisperx"], "align", align_oom_once)
    result = eng.transcribe(AUDIO, EngineOptions(diarize=False))
    assert tries == [["asr", "alignment"], ["alignment"]]
    assert result.segments


def test_oom_in_the_stage_frees_the_stage_before_repeating(
    monkeypatch: pytest.MonkeyPatch, spy: EmptyCacheSpy, fake: FakeWhisperX
):
    spy.source = fake
    eng = engine()
    tries = []
    original = fake.align

    def align_oom_once(*args: Any, **kw: Any) -> dict:
        tries.append([m["kind"] for m in eng.loaded_models()])
        if len(tries) == 1:
            msg = "CUDA out of memory"
            raise RuntimeError(msg)
        return original(*args, **kw)

    monkeypatch.setattr(sys.modules["whisperx"], "align", align_oom_once)
    eng.transcribe(AUDIO, EngineOptions(diarize=False))
    assert tries == [["asr", "alignment"], ["alignment"]]
    # The aligner that blew up is already unreachable on the first `empty_cache` of the retreat.
    assert spy.snapshots
    assert "alignment" not in spy.snapshots[0], spy.snapshots


@pytest.mark.parametrize(
    ("stage", "code"), [("alignment", "alignment_failed"), ("diarization", "diarization_failed")]
)
def test_failing_stage_leaves_the_gpu(
    monkeypatch: pytest.MonkeyPatch, spy: EmptyCacheSpy, fake: FakeWhisperX, stage: str, code: str
):
    spy.source = fake
    msg = "shape mismatch"
    if stage == "alignment":

        def boom(*_args: Any, **_kw: Any) -> dict:
            raise RuntimeError(msg)

        monkeypatch.setattr(sys.modules["whisperx"], "align", boom)
    else:
        original = sys.modules["whisperx.diarize"].DiarizationPipeline

        class Boom(original):
            def __call__(self, audio: Any, **kw: Any) -> Any:
                raise RuntimeError(msg)

        monkeypatch.setattr(sys.modules["whisperx.diarize"], "DiarizationPipeline", Boom)
    eng = engine()
    with pytest.raises(EngineError) as info:
        eng.transcribe(AUDIO, EngineOptions())
    assert info.value.code == code
    assert [m["kind"] for m in eng.loaded_models()] == ["asr"]
    # On the last `empty_cache` (the exit of the failed stage) only the resident ASR is alive.
    assert spy.snapshots[-1] == ("asr",), spy.snapshots


@pytest.mark.parametrize(("free", "batch"), [(None, 4), (6000, 4), (3500, 4), (3499, 2), (1000, 2)])
def test_initial_batch_from_the_free_vram(free: int | None, batch: int):
    assert initial_batch_size(free) == batch


def test_environment_token_wins_over_the_file(tmp_path: Path):
    file = tmp_path / "hf_token"
    file.write_text("hf_file\n")
    assert resolve_hf_token({"HF_TOKEN": " hf_env ", "ECLUME_HF_TOKEN_FILE": str(file)}) == "hf_env"
    assert resolve_hf_token({"ECLUME_HF_TOKEN_FILE": str(file)}) == "hf_file"


def test_without_token_returns_none(tmp_path: Path):
    assert resolve_hf_token({"ECLUME_HF_TOKEN_FILE": str(tmp_path / "does-not-exist")}) is None
    empty = tmp_path / "empty"
    empty.write_text("  \n")
    assert resolve_hf_token({"ECLUME_HF_TOKEN_FILE": str(empty)}) is None


def test_resident_model_for_the_heartbeat(fake: FakeWhisperX):
    eng = WhisperXLocalEngine(hf_token="hf_x", device="cuda", vram=FakeVram(), keep_asr_resident=False)
    assert eng.loaded_models() == []
    eng.transcribe(AUDIO, EngineOptions(diarize=False))
    (aligner,) = eng.loaded_models()
    assert aligner["kind"] == "alignment"
    assert aligner["name"] == "jonatasgrosman/wav2vec2-large-xlsr-53-portuguese"
    assert aligner["vram_mb"] == 640  # 3250 - 2610 of FakeVram
    assert aligner["loaded_at"].endswith("Z")
    eng.transcribe(AUDIO, EngineOptions(model="large-v3"))
    assert [m["kind"] for m in eng.loaded_models()] == ["diarization"]
    eng.unload()
    assert eng.loaded_models() == []


def test_heartbeat_declares_the_resident_asr(fake: FakeWhisperX):
    eng = engine()
    eng.transcribe(AUDIO, EngineOptions(diarize=False))
    (asr,) = eng.loaded_models()
    assert (asr["kind"], asr["name"], asr["vram_mb"]) == ("asr", "large-v3-turbo", 2210)  # 2610 - 400


def test_admin_options_batch_fallback_and_diarization_model(monkeypatch: pytest.MonkeyPatch):
    fake = FakeWhisperX(oom_models={"large-v3"})
    install(monkeypatch, fake)
    options = EngineOptions(
        model="large-v3", batch_size=2, fallback_model="small", diarization_model="pyannote/other-pipeline"
    )
    result = engine().transcribe(AUDIO, options)
    transcribes = [args[:2] for name, args in fake.calls if name == "transcribe"]
    assert transcribes == [("large-v3", 2), ("large-v3", 1), ("small", 2)]
    assert result.model == "small"
    assert WARN_FALLBACK_MEDIUM in result.warnings
    assert ("DiarizationPipeline", ("pyannote/other-pipeline", "hf_x", "cuda")) in fake.calls
    assert result.diarization_model == "pyannote/other-pipeline"


def test_environment_batch_wins_over_the_admin_one(fake: FakeWhisperX):
    eng = WhisperXLocalEngine(hf_token=None, vram=FakeVram(6000), batch_size=8)
    assert eng.transcribe(AUDIO, EngineOptions(diarize=False, batch_size=2)).batch_size == 8


def test_without_language_detects_and_aligns_by_the_detected_one(fake: FakeWhisperX):
    result = engine().transcribe(AUDIO, EngineOptions(language=None, diarize=False))
    assert result.language == "en"
    calls = dict(fake.calls)
    assert calls["load_model"][3] is None
    assert calls["transcribe"][2] is None
    assert calls["load_align_model"][0] == "en"


def test_vocabulary_becomes_hotwords_only_in_the_job_and_does_not_reload(fake: FakeWhisperX):
    eng = engine()
    eng.transcribe(AUDIO, EngineOptions(vocabulary=("Ana Souza", "Acme")))
    eng.transcribe(AUDIO, EngineOptions())
    eng.transcribe(AUDIO, EngineOptions(vocabulary=("Outra Conta",)))
    assert fake.hotwords == ["Ana Souza Acme", None, "Outra Conta"]
    assert fake.names().count("load_model") == 1


def test_hotwords_go_back_to_normal_when_the_asr_runs_out_of_memory(monkeypatch: pytest.MonkeyPatch):
    fake = FakeWhisperX(oom_batches={8})
    install(monkeypatch, fake)
    engine().transcribe(AUDIO, EngineOptions(vocabulary=("Ana",), batch_size=8))
    assert set(fake.hotwords) == {"Ana"}


def test_job_options_carry_the_vocabulary():
    assert EngineOptions.from_mapping({"vocabulary": ["Ana", " ", "Bia"]}).vocabulary == ("Ana", "Bia")
    assert EngineOptions.from_mapping({}).vocabulary == ()
