"""The worker's `transcript.raw.json` validates against `contracts/transcript.schema.json`."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker

from eclume_engines import EngineResult, Segment, Word
from eclume_worker.transcript import build_embeddings, build_transcript, speaker_map

SCHEMA = json.loads((Path(__file__).parents[2] / "contracts" / "transcript.schema.json").read_text())
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
RECORDING = "01928f3a-1c00-7a00-8000-000000000401"
HASH = "sha256:" + "ab" * 32
NOW = datetime(2026, 9, 24, 12, 0, tzinfo=UTC)


def result_of(*, diarized: bool = True) -> EngineResult:
    spk = (lambda s: s) if diarized else (lambda _s: None)
    return EngineResult(
        engine="whisperx-local",
        model="large-v3-turbo",
        compute_type="int8_float16",
        language="pt",
        duration_s=12.3456,
        segments=[
            Segment(
                0.2,
                2.0,
                "Bom dia a todos.",
                spk("SPEAKER_01"),
                [
                    Word("Bom", 0.2, 0.5, 0.9),
                    Word("dia", 0.6, 0.9, 0.8),
                    Word("a", None, None),
                    Word("todos.", 1.2, 1.1, 0.7),
                ],
                0.8,
            ),
            Segment(2.5, 5.0, "Bom dia, Mariana.", spk("SPEAKER_00"), [Word("Bom", 2.5, 2.8, 0.95)], 0.95),
            Segment(5.1, 6.0, "Vamos lá.", None, [], None),
            Segment(6.5, 9.0, "Primeiro item.", spk("SPEAKER_01"), [], 0.7),
        ],
        speaker_embeddings={"SPEAKER_00": [0.1, 0.2, 0.3], "SPEAKER_01": [0.4, 0.5, 0.6], "SPEAKER_02": [0.0, 0.0, 1.0]}
        if diarized
        else {},
        diarization_model="pyannote/speaker-diarization-community-1" if diarized else None,
        embedding_model="pyannote/wespeaker-voxceleb-resnet34-LM" if diarized else None,
    )


def assemble(result: EngineResult) -> dict:
    return build_transcript(result, recording_id=RECORDING, revision=2, content_hash=HASH, language="pt", now=NOW)


def assert_valid(doc: dict) -> None:
    errors = sorted(VALIDATOR.iter_errors(doc), key=lambda e: list(e.path))
    assert not errors, [f"{list(e.path)}: {e.message}" for e in errors]


def test_diarized_raw_validates_against_the_schema():
    doc = assemble(result_of())
    assert_valid(doc)
    assert doc["recording_id"] == RECORDING
    assert doc["revision"] == 2
    assert doc["content_hash"] == HASH
    assert doc["duration_ms"] == 12346
    assert doc["engine"] == {
        "name": "whisperx-local",
        "model": "large-v3-turbo",
        "diarization_model": "pyannote/speaker-diarization-community-1",
    }


def test_speakers_in_order_of_first_speech_with_no_person_or_suggestions():
    doc = assemble(result_of())
    assert doc["speakers"] == [
        {"id": "S1", "label": "Locutor 1", "person": None, "talk_ms": 1800 + 2500},
        {"id": "S2", "label": "Locutor 2", "person": None, "talk_ms": 2500 + 900},
    ]
    assert [s["speaker_id"] for s in doc["segments"]] == ["S1", "S2", "S2", "S1"]


def test_segments_and_words_in_milliseconds():
    first = assemble(result_of())["segments"][0]
    assert first["id"] == "seg-0001"
    assert (first["start_ms"], first["end_ms"]) == (200, 2000)
    assert first["confidence"] == 0.8
    assert first["words"][2] == {"text": "a", "start_ms": None, "end_ms": None}
    assert first["words"][3] == {"text": "todos.", "start_ms": 1200, "end_ms": 1200, "confidence": 0.7}
    assert "words" not in assemble(result_of())["segments"][2]


def test_without_diarization_one_speaker():
    doc = assemble(result_of(diarized=False))
    assert_valid(doc)
    assert [s["id"] for s in doc["speakers"]] == ["S1"]
    assert {s["speaker_id"] for s in doc["segments"]} == {"S1"}
    assert doc["engine"]["diarization_model"] is None


def test_empty_transcript_still_validates():
    empty = EngineResult(engine="cpu", model="small", compute_type="int8", language="pt", duration_s=0.0, segments=[])
    doc = assemble(empty)
    assert_valid(doc)
    assert doc["speakers"] == [{"id": "S1", "label": "Locutor 1", "person": None, "talk_ms": 0}]


def test_embeddings_by_transcript_ids():
    emb = build_embeddings(result_of())
    assert emb == {
        "embedding_model": "pyannote/wespeaker-voxceleb-resnet34-LM",
        "dimension": 3,
        "speaker_embeddings": {"S1": [0.4, 0.5, 0.6], "S2": [0.1, 0.2, 0.3]},
    }


def test_empty_embeddings_without_diarization():
    assert build_embeddings(result_of(diarized=False)) == {
        "embedding_model": None,
        "dimension": None,
        "speaker_embeddings": {},
    }


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_embedding_is_left_out(bad: float):
    # Speech that is too short: pyannote returns NaN (standard deviation with zero degrees of freedom),
    # and pgvector would refuse the whole ingestion. The speaker stays in the transcript, just without an embedding.
    result = result_of()
    result.speaker_embeddings["SPEAKER_00"] = [0.1, bad, 0.3]
    emb = build_embeddings(result)
    assert emb["speaker_embeddings"] == {"S1": [0.4, 0.5, 0.6]}
    assert emb["dimension"] == 3
    assert [s["id"] for s in assemble(result)["speakers"]] == ["S1", "S2"]


def test_only_non_finite_embeddings_leaves_no_model():
    result = result_of()
    result.speaker_embeddings = {"SPEAKER_01": [float("nan")] * 3}
    assert build_embeddings(result) == {"embedding_model": None, "dimension": None, "speaker_embeddings": {}}


@pytest.mark.parametrize("diarized", [True, False])
def test_speaker_map_covers_every_segment(*, diarized: bool):
    mapping = speaker_map(result_of(diarized=diarized))
    assert set(mapping.values()) <= {"S1", "S2"}
