"""Engine `openai-compatible` against `httpx.MockTransport`."""

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


def engine_with(handler: object, **kw: object) -> object:
    return get_engine(
        "openai-compatible",
        base_url="http://speaches:8000/",
        api_key="secret",
        transport=httpx.MockTransport(handler),
        **kw,
    )


@pytest.fixture
def audio(tmp_path: Path) -> Path:
    path = tmp_path / "recording.ogg"
    path.write_bytes(b"OggS-fake")
    return path


def test_sends_verbose_json_and_converts_top_level_words(audio: Path):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=VERBOSE_OPENAI)

    result = engine_with(handler).transcribe(audio, EngineOptions(model="large-v3-turbo", diarize=False))

    [request] = requests
    assert request.url == "http://speaches:8000/v1/audio/transcriptions"
    assert request.headers["Authorization"] == "Bearer secret"
    body = request.content.decode()
    for field in ('name="model"', "large-v3-turbo", "verbose_json", 'name="timestamp_granularities[]"', "OggS-fake"):
        assert field in body
    assert body.count('name="timestamp_granularities[]"') == 2

    assert result.engine == "openai-compatible"
    assert result.model == "large-v3-turbo"
    assert result.duration_s == 4.0
    assert result.warnings == []
    first, second = result.segments
    assert [w.text for w in first.words] == ["Olá."]
    assert [w.text for w in second.words] == ["Tudo", "bem?"]
    assert first.confidence == pytest.approx(0.8187, abs=1e-3)


def test_words_inside_segments_are_not_duplicated(audio: Path):
    body = {
        "duration": 1.0,
        "segments": [{"start": 0.0, "end": 1.0, "text": "Oi", "words": [{"word": "Oi", "start": 0.0, "end": 0.5}]}],
        "words": [{"word": "Oi", "start": 0.0, "end": 0.5}],
    }
    result = engine_with(lambda _r: httpx.Response(200, json=body)).transcribe(audio, EngineOptions())
    assert [w.text for w in result.segments[0].words] == ["Oi"]
    assert result.warnings == ["diarization_unavailable_remote"]


def test_http_error_becomes_asr_failed(audio: Path):
    with pytest.raises(EngineError) as info:
        engine_with(lambda _r: httpx.Response(503, text="unavailable")).transcribe(audio, EngineOptions())
    assert info.value.code == "asr_failed"
