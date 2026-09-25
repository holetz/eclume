"""Engine `whisperx-local` sobre um módulo `whisperx` fake: a forma das chamadas e as regras."""

from __future__ import annotations

import sys
import types
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
    WARN_NO_TOKEN,
    WhisperXLocalEngine,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

AUDIO = Path("/tmp/audio.ogg")  # noqa: S108 — o fake não abre o arquivo


class FakeAudio:
    """Só o `len` do array de amostras importa para a engine."""

    def __init__(self, samples: int) -> None:
        self.samples = samples

    def __len__(self) -> int:
        return self.samples


class FakeVram:
    def __init__(self, free: int | None = 6000) -> None:
        self.free = free

    def free_mb(self) -> int | None:
        return self.free

    @contextmanager
    def track(self) -> Iterator[PeakVram]:
        peak = PeakVram(baseline=300)
        yield peak
        peak.observe(2800)


class FakeWhisperX:
    """Registra as chamadas; `oom_batches` define os lotes que estouram a memória."""

    def __init__(self, oom_batches: set[int] | None = None, oom_models: set[str] | None = None) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.oom_batches = oom_batches or set()
        self.oom_models = oom_models or set()

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

    def load_model(self, model: str, device: str, *, compute_type: str, language: str) -> Any:
        self.calls.append(("load_model", (model, device, compute_type, language)))
        fake = self

        class Pipeline:
            def transcribe(self, audio: Any, *, batch_size: int, language: str, progress_callback: Any) -> dict:
                fake.calls.append(("transcribe", (model, batch_size, language)))
                if model in fake.oom_models or batch_size in fake.oom_batches:
                    msg = "CUDA failed with error out of memory"
                    raise RuntimeError(msg)
                progress_callback(50.0)
                return {
                    "segments": [
                        {"start": 0.0, "end": 2.0, "text": " Olá, tudo bem?"},
                        {"start": 2.5, "end": 4.0, "text": " Tudo ótimo."},
                    ],
                    "language": language,
                }

        return Pipeline()

    def load_align_model(self, *, language_code: str, device: str) -> tuple[Any, dict]:
        self.calls.append(("load_align_model", (language_code, device)))
        return object(), {"language": language_code, "dictionary": {}, "type": "huggingface"}

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


def test_fabrica_devolve_a_engine_whisperx():
    assert get_engine("whisperx-local", vram=FakeVram()).name == "whisperx-local"


def test_pipeline_completo_com_diarizacao_e_embeddings(fake: FakeWhisperX):
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
    assert result.batch_size == 16
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
    assert second.words[2].score is None  # NaN vira ausência
    assert [s for s, _ in stages] == ["asr", "asr", "align", "diarize", "diarize", "embed"]


def test_sem_token_degrada_para_um_locutor(fake: FakeWhisperX):
    result = engine(token=None).transcribe(AUDIO, EngineOptions())
    assert "DiarizationPipeline" not in fake.names()
    assert result.warnings == [WARN_NO_TOKEN]
    assert result.speaker_embeddings == {}
    assert result.diarization_model is None
    assert result.embedding_model is None
    assert all(s.speaker is None for s in result.segments)


def test_sem_diarizacao_pedida_nao_avisa(fake: FakeWhisperX):
    result = engine(token=None).transcribe(AUDIO, EngineOptions(diarize=False))
    assert result.warnings == []
    assert "DiarizationPipeline" not in fake.names()


def test_diarizacao_sem_embeddings(fake: FakeWhisperX):
    result = engine().transcribe(AUDIO, EngineOptions(embeddings=False))
    assert dict(fake.calls)["diarize"]["return_embeddings"] is False
    assert result.speaker_embeddings == {}
    assert result.embedding_model is None
    assert result.diarization_model == DIARIZATION_MODEL


def test_oom_reduz_o_lote_pela_metade(monkeypatch: pytest.MonkeyPatch):
    fake = FakeWhisperX(oom_batches={16, 8})
    install(monkeypatch, fake)
    result = engine().transcribe(AUDIO, EngineOptions(diarize=False))
    batches = [args[1] for name, args in fake.calls if name == "transcribe"]
    assert batches == [16, 8, 4]
    assert result.batch_size == 4
    assert result.warnings == [WARN_BATCH_REDUCED]


def test_oom_persistente_cai_para_medium(monkeypatch: pytest.MonkeyPatch):
    fake = FakeWhisperX(oom_models={"large-v3-turbo"})
    install(monkeypatch, fake)
    result = engine(free=3000).transcribe(AUDIO, EngineOptions(diarize=False))
    transcribes = [args[:2] for name, args in fake.calls if name == "transcribe"]
    assert transcribes == [("large-v3-turbo", 4), ("large-v3-turbo", 2), ("large-v3-turbo", 1), ("medium", 4)]
    assert result.model == "medium"
    assert result.warnings == [WARN_BATCH_REDUCED, WARN_FALLBACK_MEDIUM]


def test_oom_ate_no_medium_falha_com_out_of_memory(monkeypatch: pytest.MonkeyPatch):
    fake = FakeWhisperX(oom_models={"large-v3-turbo", "medium"})
    install(monkeypatch, fake)
    with pytest.raises(EngineError) as info:
        engine(free=1000).transcribe(AUDIO, EngineOptions(diarize=False))
    assert info.value.code == "out_of_memory"


def test_float16_e_recusado(fake: FakeWhisperX):
    result = engine().transcribe(AUDIO, EngineOptions(compute_type="float16", diarize=False))
    assert result.compute_type == "int8_float16"
    assert result.warnings == [WARN_FLOAT16_REJECTED]


def test_compute_type_recusado_pelo_backend_recua_para_int8(monkeypatch: pytest.MonkeyPatch):
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


def test_erro_de_decodificacao(monkeypatch: pytest.MonkeyPatch, fake: FakeWhisperX):
    def boom(_path: str) -> None:
        msg = "ffmpeg: invalid data"
        raise RuntimeError(msg)

    monkeypatch.setattr(sys.modules["whisperx"], "load_audio", boom)
    with pytest.raises(EngineError) as info:
        engine().transcribe(AUDIO, EngineOptions())
    assert info.value.code == "audio_decode_failed"


def test_falha_da_diarizacao_com_token_falha_o_job(monkeypatch: pytest.MonkeyPatch, fake: FakeWhisperX):
    class Boom:
        def __init__(self, **_kw: Any) -> None:
            msg = "401 Unauthorized: gated repo"
            raise RuntimeError(msg)

    monkeypatch.setattr(sys.modules["whisperx.diarize"], "DiarizationPipeline", Boom)
    with pytest.raises(EngineError) as info:
        engine().transcribe(AUDIO, EngineOptions())
    assert info.value.code == "diarization_failed"


def test_um_modelo_residente_por_vez(fake: FakeWhisperX):
    eng = engine()
    eng.transcribe(AUDIO, EngineOptions())
    assert eng._slot_key == ("diarize", DIARIZATION_MODEL)
    eng.unload()
    assert eng._slot is None


@pytest.mark.parametrize(("free", "batch"), [(None, 8), (6000, 16), (5000, 16), (4000, 8), (3500, 8), (2000, 4)])
def test_lote_inicial_pela_vram_livre(free: int | None, batch: int):
    assert initial_batch_size(free) == batch


def test_token_do_ambiente_vence_o_arquivo(tmp_path: Path):
    arquivo = tmp_path / "hf_token"
    arquivo.write_text("hf_arquivo\n")
    assert resolve_hf_token({"HF_TOKEN": " hf_env ", "ECLUME_HF_TOKEN_FILE": str(arquivo)}) == "hf_env"
    assert resolve_hf_token({"ECLUME_HF_TOKEN_FILE": str(arquivo)}) == "hf_arquivo"


def test_sem_token_devolve_none(tmp_path: Path):
    assert resolve_hf_token({"ECLUME_HF_TOKEN_FILE": str(tmp_path / "nao-existe")}) is None
    vazio = tmp_path / "vazio"
    vazio.write_text("  \n")
    assert resolve_hf_token({"ECLUME_HF_TOKEN_FILE": str(vazio)}) is None
