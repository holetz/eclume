"""Engine `cpu` over a fake `faster_whisper` module."""

from __future__ import annotations

import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

from eclume_engines import EngineOptions, get_engine
from eclume_engines.base import EngineError
from eclume_engines.cpu import WARN_NO_DIARIZATION

# Languages requested from the fake's `transcribe`, in order.
LANGUAGES: list[str | None] = []


@pytest.fixture
def models(monkeypatch: pytest.MonkeyPatch) -> list[tuple]:
    created: list[tuple] = []
    LANGUAGES.clear()

    class WhisperModel:
        def __init__(self, model: str, *, device: str, compute_type: str, cpu_threads: int) -> None:
            created.append((model, device, compute_type, cpu_threads))

        def transcribe(self, path: str, **kw: object) -> tuple:
            if path.endswith(".bad"):
                msg = "Invalid data found when processing input"
                raise RuntimeError(msg)
            assert kw["word_timestamps"] is True
            assert kw["vad_filter"] is True
            LANGUAGES.append(kw["language"])
            words = [
                SimpleNamespace(word=" Bom", start=0.0, end=0.4, probability=0.9),
                SimpleNamespace(word=" dia.", start=0.5, end=1.0, probability=0.8),
            ]
            segments = iter([SimpleNamespace(start=0.0, end=1.0, text=" Bom dia.", words=words, avg_logprob=-0.1)])
            # faster-whisper reports the detected (or requested) language.
            return segments, SimpleNamespace(duration=2.0, language=kw["language"] or "en")

    mod = types.ModuleType("faster_whisper")
    mod.WhisperModel = WhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", mod)
    return created


def test_transcribes_with_small_int8_and_one_speaker(models: list[tuple]):
    engine = get_engine("cpu")
    stages: list[tuple[str, float]] = []
    result = engine.transcribe(Path("a.ogg"), EngineOptions(), lambda s, p: stages.append((s, p)))
    assert models == [("small", "cpu", "int8", 0)]
    assert (LANGUAGES, result.language) == (["pt"], "pt")
    assert result.engine == "cpu"
    assert result.model == "small"
    assert result.compute_type == "int8"
    assert result.duration_s == 2.0
    assert result.warnings == [WARN_NO_DIARIZATION]
    [seg] = result.segments
    assert seg.text == "Bom dia."
    assert seg.speaker is None
    assert [w.text for w in seg.words] == ["Bom", "dia."]
    assert seg.confidence == pytest.approx(0.905, abs=1e-3)
    assert stages == [("asr", 50.0)]


def test_reuses_the_model_and_unloads(models: list[tuple]):
    engine = get_engine("cpu")
    engine.transcribe(Path("a.ogg"), EngineOptions(diarize=False))
    engine.transcribe(Path("b.ogg"), EngineOptions(diarize=False))
    assert len(models) == 1
    engine.unload()
    engine.transcribe(Path("c.ogg"), EngineOptions(diarize=False))
    assert len(models) == 2


def test_invalid_audio(models: list[tuple]):
    with pytest.raises(EngineError) as info:
        get_engine("cpu").transcribe(Path("a.bad"), EngineOptions())
    assert info.value.code == "audio_decode_failed"


def test_without_language_faster_whisper_detects(models: list[tuple]):
    result = get_engine("cpu").transcribe(Path("a.ogg"), EngineOptions(language=None))
    assert models == [("small", "cpu", "int8", 0)]
    assert (LANGUAGES, result.language) == ([None], "en")
