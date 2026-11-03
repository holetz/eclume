"""Benchmark CLI with a fake engine."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

from eclume_engines import EngineOptions, EngineResult, Segment
from eclume_worker.bench import parse_args, run

SCHEMA = json.loads((Path(__file__).parents[2] / "contracts" / "transcript.schema.json").read_text())


class FakeEngine:
    name = "whisperx-local"

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.options: EngineOptions | None = None
        self.unloaded = False

    def transcribe(self, audio_path: Path, options: EngineOptions, progress: Any = None) -> EngineResult:
        self.options = options
        return EngineResult(
            engine="whisperx-local",
            model="large-v3-turbo",
            compute_type="int8_float16",
            language="pt",
            duration_s=3600.0,
            segments=[Segment(0.0, 1.0, "Oi.", "SPEAKER_00")],
            batch_size=16,
            peak_vram_mb=3100,
            warnings=["diarization_skipped_no_token"],
        )

    def unload(self) -> None:
        self.unloaded = True


def test_benchmark_measures_and_writes_the_transcript(tmp_path: Path, monkeypatch: Any):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.setenv("ECLUME_HF_TOKEN_FILE", str(tmp_path / "no-token"))
    audio = tmp_path / "bench.ogg"
    audio.write_bytes(b"OggS")
    output = tmp_path / "t.json"
    engines: list[FakeEngine] = []

    def factory(name: str, **kwargs: Any) -> FakeEngine:
        assert name == "whisperx-local"
        engines.append(FakeEngine(**kwargs))
        return engines[-1]

    report = run(parse_args([str(audio), "--no-diarize", "--transcript", str(output)]), factory=factory)

    [engine] = engines
    assert engine.kwargs == {"device": "cuda", "hf_token": None, "batch_size": None, "keep_asr_resident": True}
    assert engine.options is not None
    assert engine.options.diarize is False
    assert engine.unloaded
    assert report["duration_s"] == 3600.0
    assert report["peak_vram_mb"] == 3100
    assert report["realtime_factor"] is not None
    assert report["minutes_per_audio_hour"] == round(report["realtime_factor"] * 60, 2)
    assert report["speakers"] == 1
    Draft202012Validator(SCHEMA, format_checker=FormatChecker()).validate(json.loads(output.read_text()))


def _factory(name: str, **kwargs: Any) -> FakeEngine:
    return FakeEngine(**kwargs)


def test_benchmark_without_reference_has_no_quality(tmp_path: Path):
    audio = tmp_path / "bench.ogg"
    audio.write_bytes(b"OggS")
    assert "quality" not in run(parse_args([str(audio), "--no-diarize"]), factory=_factory)


def test_benchmark_measures_wer_and_cer_against_the_reference(tmp_path: Path):
    audio = tmp_path / "bench.ogg"
    audio.write_bytes(b"OggS")
    reference = tmp_path / "ref.txt"
    reference.write_text("Oi, tudo.", encoding="utf-8")

    report = run(parse_args([str(audio), "--no-diarize", "--reference", str(reference)]), factory=_factory)

    assert report["quality"]["wer"] == {
        "rate": 0.5,
        "reference_len": 2,
        "substitutions": 0,
        "deletions": 1,
        "insertions": 0,
    }
    assert report["quality"]["cer"]["rate"] == round(5 / 7, 4)
