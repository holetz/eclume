"""Engine `openai-compatible` contra `httpx.MockTransport`."""

from __future__ import annotations

from typing import TYPE_CHECKING

import httpx
import pytest

from eclume_engines import EngineOptions, get_engine
from eclume_engines.base import EngineError

if TYPE_CHECKING:
    from pathlib import Path

VERBOSE_OPENAI = {
    "language": "portuguese",
    "duration": 4.0,
    "text": "Olá. Tudo bem?",
    "segments": [
        {"id": 0, "start": 0.0, "end": 1.0, "text": " Olá.", "avg_logprob": -0.2},
        {"id": 1, "start": 1.5, "end": 3.0, "text": " Tudo bem?", "avg_logprob": -0.3},
    ],
    "words": [
        {"word": "Olá.", "start": 0.0, "end": 0.8},
        {"word": "Tudo", "start": 1.5, "end": 2.0},
        {"word": "bem?", "start": 2.1, "end": 3.0},
    ],
}


def engine_com(handler: object, **kw: object) -> object:
    return get_engine(
        "openai-compatible",
        base_url="http://speaches:8000/",
        api_key="segredo",
        transport=httpx.MockTransport(handler),
        **kw,
    )


@pytest.fixture
def audio(tmp_path: Path) -> Path:
    path = tmp_path / "gravacao.ogg"
    path.write_bytes(b"OggS-fake")
    return path


def test_envia_verbose_json_e_converte_palavras_do_topo(audio: Path):
    pedidos: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        pedidos.append(request)
        return httpx.Response(200, json=VERBOSE_OPENAI)

    result = engine_com(handler).transcribe(audio, EngineOptions(model="large-v3-turbo", diarize=False))

    [pedido] = pedidos
    assert pedido.url == "http://speaches:8000/v1/audio/transcriptions"
    assert pedido.headers["Authorization"] == "Bearer segredo"
    corpo = pedido.content.decode()
    for campo in ('name="model"', "large-v3-turbo", "verbose_json", 'name="timestamp_granularities[]"', "OggS-fake"):
        assert campo in corpo
    assert corpo.count('name="timestamp_granularities[]"') == 2

    assert result.engine == "openai-compatible"
    assert result.model == "large-v3-turbo"
    assert result.duration_s == 4.0
    assert result.warnings == []
    first, second = result.segments
    assert [w.text for w in first.words] == ["Olá."]
    assert [w.text for w in second.words] == ["Tudo", "bem?"]
    assert first.confidence == pytest.approx(0.8187, abs=1e-3)


def test_palavras_dentro_dos_segmentos_nao_duplicam(audio: Path):
    corpo = {
        "duration": 1.0,
        "segments": [{"start": 0.0, "end": 1.0, "text": "Oi", "words": [{"word": "Oi", "start": 0.0, "end": 0.5}]}],
        "words": [{"word": "Oi", "start": 0.0, "end": 0.5}],
    }
    result = engine_com(lambda _r: httpx.Response(200, json=corpo)).transcribe(audio, EngineOptions())
    assert [w.text for w in result.segments[0].words] == ["Oi"]
    assert result.warnings == ["diarization_unavailable_remote"]


def test_erro_http_vira_asr_failed(audio: Path):
    with pytest.raises(EngineError) as info:
        engine_com(lambda _r: httpx.Response(503, text="indisponível")).transcribe(audio, EngineOptions())
    assert info.value.code == "asr_failed"
