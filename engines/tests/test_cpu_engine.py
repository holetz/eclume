"""Engine `cpu` sobre um módulo `faster_whisper` fake."""

from __future__ import annotations

import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

from eclume_engines import EngineOptions, get_engine
from eclume_engines.base import EngineError
from eclume_engines.cpu import WARN_NO_DIARIZATION

# Idiomas pedidos ao `transcribe` do fake, na ordem.
IDIOMAS: list[str | None] = []


@pytest.fixture
def modelos(monkeypatch: pytest.MonkeyPatch) -> list[tuple]:
    criados: list[tuple] = []
    IDIOMAS.clear()

    class WhisperModel:
        def __init__(self, model: str, *, device: str, compute_type: str, cpu_threads: int) -> None:
            criados.append((model, device, compute_type, cpu_threads))

        def transcribe(self, path: str, **kw: object) -> tuple:
            if path.endswith(".bad"):
                msg = "Invalid data found when processing input"
                raise RuntimeError(msg)
            assert kw["word_timestamps"] is True
            assert kw["vad_filter"] is True
            IDIOMAS.append(kw["language"])
            words = [
                SimpleNamespace(word=" Bom", start=0.0, end=0.4, probability=0.9),
                SimpleNamespace(word=" dia.", start=0.5, end=1.0, probability=0.8),
            ]
            segments = iter([SimpleNamespace(start=0.0, end=1.0, text=" Bom dia.", words=words, avg_logprob=-0.1)])
            # O faster-whisper informa o idioma detectado (ou o pedido).
            return segments, SimpleNamespace(duration=2.0, language=kw["language"] or "en")

    mod = types.ModuleType("faster_whisper")
    mod.WhisperModel = WhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", mod)
    return criados


def test_transcreve_com_small_int8_e_um_locutor(modelos: list[tuple]):
    engine = get_engine("cpu")
    etapas: list[tuple[str, float]] = []
    result = engine.transcribe(Path("a.ogg"), EngineOptions(), lambda s, p: etapas.append((s, p)))
    assert modelos == [("small", "cpu", "int8", 0)]
    assert (IDIOMAS, result.language) == (["pt"], "pt")
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
    assert etapas == [("asr", 50.0)]


def test_reaproveita_o_modelo_e_descarrega(modelos: list[tuple]):
    engine = get_engine("cpu")
    engine.transcribe(Path("a.ogg"), EngineOptions(diarize=False))
    engine.transcribe(Path("b.ogg"), EngineOptions(diarize=False))
    assert len(modelos) == 1
    engine.unload()
    engine.transcribe(Path("c.ogg"), EngineOptions(diarize=False))
    assert len(modelos) == 2


def test_audio_invalido(modelos: list[tuple]):
    with pytest.raises(EngineError) as info:
        get_engine("cpu").transcribe(Path("a.bad"), EngineOptions())
    assert info.value.code == "audio_decode_failed"


def test_sem_idioma_o_faster_whisper_detecta(modelos: list[tuple]):
    result = get_engine("cpu").transcribe(Path("a.ogg"), EngineOptions(language=None))
    assert modelos == [("small", "cpu", "int8", 0)]
    assert (IDIOMAS, result.language) == ([None], "en")
