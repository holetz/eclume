"""O `transcript.raw.json` do worker valida contra `contracts/transcript.schema.json`."""

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


def resultado(*, diarizado: bool = True) -> EngineResult:
    spk = (lambda s: s) if diarizado else (lambda _s: None)
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
        if diarizado
        else {},
        diarization_model="pyannote/speaker-diarization-community-1" if diarizado else None,
        embedding_model="pyannote/wespeaker-voxceleb-resnet34-LM" if diarizado else None,
    )


def montar(result: EngineResult) -> dict:
    return build_transcript(result, recording_id=RECORDING, revision=2, content_hash=HASH, language="pt", now=NOW)


def assert_valido(doc: dict) -> None:
    erros = sorted(VALIDATOR.iter_errors(doc), key=lambda e: list(e.path))
    assert not erros, [f"{list(e.path)}: {e.message}" for e in erros]


def test_raw_diarizado_valida_no_schema():
    doc = montar(resultado())
    assert_valido(doc)
    assert doc["recording_id"] == RECORDING
    assert doc["revision"] == 2
    assert doc["content_hash"] == HASH
    assert doc["duration_ms"] == 12346
    assert doc["engine"] == {
        "name": "whisperx-local",
        "model": "large-v3-turbo",
        "diarization_model": "pyannote/speaker-diarization-community-1",
    }


def test_locutores_pela_ordem_da_primeira_fala_sem_pessoa_nem_sugestoes():
    doc = montar(resultado())
    assert doc["speakers"] == [
        {"id": "S1", "label": "Locutor 1", "person": None, "talk_ms": 1800 + 2500},
        {"id": "S2", "label": "Locutor 2", "person": None, "talk_ms": 2500 + 900},
    ]
    assert [s["speaker_id"] for s in doc["segments"]] == ["S1", "S2", "S2", "S1"]


def test_segmentos_e_palavras_em_milissegundos():
    first = montar(resultado())["segments"][0]
    assert first["id"] == "seg-0001"
    assert (first["start_ms"], first["end_ms"]) == (200, 2000)
    assert first["confidence"] == 0.8
    assert first["words"][2] == {"text": "a", "start_ms": None, "end_ms": None}
    assert first["words"][3] == {"text": "todos.", "start_ms": 1200, "end_ms": 1200, "confidence": 0.7}
    assert "words" not in montar(resultado())["segments"][2]


def test_sem_diarizacao_um_locutor():
    doc = montar(resultado(diarizado=False))
    assert_valido(doc)
    assert [s["id"] for s in doc["speakers"]] == ["S1"]
    assert {s["speaker_id"] for s in doc["segments"]} == {"S1"}
    assert doc["engine"]["diarization_model"] is None


def test_transcricao_vazia_ainda_valida():
    vazio = EngineResult(engine="cpu", model="small", compute_type="int8", language="pt", duration_s=0.0, segments=[])
    doc = montar(vazio)
    assert_valido(doc)
    assert doc["speakers"] == [{"id": "S1", "label": "Locutor 1", "person": None, "talk_ms": 0}]


def test_embeddings_pelos_ids_do_transcript():
    emb = build_embeddings(resultado())
    assert emb == {
        "embedding_model": "pyannote/wespeaker-voxceleb-resnet34-LM",
        "dimension": 3,
        "speaker_embeddings": {"S1": [0.4, 0.5, 0.6], "S2": [0.1, 0.2, 0.3]},
    }


def test_embeddings_vazios_sem_diarizacao():
    assert build_embeddings(resultado(diarizado=False)) == {
        "embedding_model": None,
        "dimension": None,
        "speaker_embeddings": {},
    }


@pytest.mark.parametrize("diarizado", [True, False])
def test_mapa_de_locutores_cobre_todo_segmento(*, diarizado: bool):
    mapa = speaker_map(resultado(diarizado=diarizado))
    assert set(mapa.values()) <= {"S1", "S2"}
