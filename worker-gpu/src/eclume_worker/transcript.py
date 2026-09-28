"""Montagem do `transcript.raw.json` e do `speaker_embeddings.json` a partir do `EngineResult`.

O raw segue `contracts/transcript.schema.json`. Os campos de identidade que só o server conhece
(`id`, `title`, `owner`, `recorded_at`, `source`, `created_at`, `updated_at`) saem provisórios,
só para o arquivo validar; o server os sobrescreve na ingestão (docs/standards/api/jobs-transcricao.md).
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from datetime import datetime

    from eclume_engines import EngineResult, Word

SCHEMA_VERSION = "1.0"
PROVISIONAL_OWNER = {"id": "00000000-0000-0000-0000-000000000000", "name": "eclume-worker"}
PROVISIONAL_SOURCE = "upload"


def _ms(seconds: float) -> int:
    return max(0, round(seconds * 1000))


def speaker_map(result: EngineResult) -> dict[str | None, str]:
    """Rótulo bruto da diarização → `S<n>`, pela ordem da primeira fala.

    Sem diarização (nenhum rótulo), o mapa é `{None: "S1"}`: um locutor só.
    """
    mapping: dict[str | None, str] = {}
    for segment in sorted(result.segments, key=lambda s: s.start):
        if segment.speaker is not None and segment.speaker not in mapping:
            mapping[segment.speaker] = f"S{len(mapping) + 1}"
    return mapping or {None: "S1"}


def _segment_speakers(result: EngineResult, mapping: dict[str | None, str]) -> list[str]:
    """Id de locutor por segmento; sem rótulo, herda o anterior (ou o primeiro que aparecer)."""
    first = next(iter(mapping.values()))
    ids: list[str] = []
    previous: str | None = None
    for segment in result.segments:
        current = mapping.get(segment.speaker) if segment.speaker is not None else None
        current = current or previous or first
        ids.append(current)
        previous = current
    return ids


def _word(word: Word, offset_ms: int) -> dict[str, Any]:
    start = None if word.start is None else _ms(word.start) + offset_ms
    end = None if word.end is None else _ms(word.end) + offset_ms
    if start is not None and end is not None:
        end = max(end, start)
    out: dict[str, Any] = {"text": word.text, "start_ms": start, "end_ms": end}
    if word.score is not None:
        out["confidence"] = round(word.score, 4)
    return out


def build_transcript(  # noqa: PLR0913 — todos keyword-only: os metadados do job
    result: EngineResult,
    *,
    recording_id: str,
    revision: int,
    content_hash: str,
    language: str,
    now: datetime,
    offset_ms: int = 0,
    duration_ms: int | None = None,
) -> dict[str, Any]:
    """Transcrição no schema do contrato, com locutores `Locutor N` e `person: null`.

    `offset_ms` é o silêncio que o pré-processamento cortou do início: somado a todo tempo de
    segmento e palavra, as marcas voltam a ser as do áudio original, que o usuário ouve.
    `duration_ms` é a duração desse original; sem ela, a do áudio tratado mais o deslocamento (o
    silêncio cortado do fim fica de fora).
    """
    mapping = speaker_map(result)
    speaker_ids = _segment_speakers(result, mapping)
    talk_ms = dict.fromkeys(mapping.values(), 0)
    segments: list[dict[str, Any]] = []
    for index, (segment, speaker_id) in enumerate(zip(result.segments, speaker_ids, strict=True), start=1):
        start_ms = _ms(segment.start) + offset_ms
        end_ms = max(_ms(segment.end) + offset_ms, start_ms)
        talk_ms[speaker_id] += end_ms - start_ms
        out: dict[str, Any] = {
            "id": f"seg-{index:04d}",
            "speaker_id": speaker_id,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "text": segment.text,
        }
        if segment.confidence is not None:
            out["confidence"] = round(min(1.0, max(0.0, segment.confidence)), 4)
        if segment.words:
            out["words"] = [_word(w, offset_ms) for w in segment.words]
        segments.append(out)

    speakers = [
        {"id": sid, "label": f"Locutor {sid[1:]}", "person": None, "talk_ms": talk_ms[sid]}
        for sid in sorted(set(mapping.values()), key=lambda s: int(s[1:]))
    ]
    timestamp = now.isoformat().replace("+00:00", "Z")
    return {
        "schema_version": SCHEMA_VERSION,
        "id": recording_id,
        "recording_id": recording_id,
        "title": f"Gravação {recording_id}",
        "language": language,
        "recorded_at": timestamp,
        "duration_ms": duration_ms if duration_ms is not None else _ms(result.duration_s) + offset_ms,
        "source": PROVISIONAL_SOURCE,
        "content_hash": content_hash,
        "revision": revision,
        "created_at": timestamp,
        "updated_at": timestamp,
        "owner": dict(PROVISIONAL_OWNER),
        "engine": {
            "name": result.engine,
            "model": result.model,
            "diarization_model": result.diarization_model,
        },
        "speakers": speakers,
        "segments": segments,
    }


def build_embeddings(result: EngineResult) -> dict[str, Any]:
    """`speaker_embeddings.json`: vetores por id de locutor do transcript (`S<n>`).

    Rótulos da diarização sem nenhuma fala no transcript ficam de fora: não há locutor para eles.
    Vetor com componente não finito (NaN ou infinito, o que o pyannote produz para fala curta
    demais) também fica: o locutor segue sem embedding, e o pgvector recusaria a ingestão inteira.
    """
    mapping = speaker_map(result)
    vectors = {}
    for label, vector in result.speaker_embeddings.items():
        if label not in mapping:
            continue
        values = [float(x) for x in vector]
        if all(math.isfinite(x) for x in values):
            vectors[mapping[label]] = values
    dimension = len(next(iter(vectors.values()))) if vectors else None
    return {
        "embedding_model": result.embedding_model if vectors else None,
        "dimension": dimension,
        "speaker_embeddings": dict(sorted(vectors.items(), key=lambda kv: int(kv[0][1:]))),
    }
