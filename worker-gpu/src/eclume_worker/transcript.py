"""Assembly of `transcript.raw.json` and `speaker_embeddings.json` from the `EngineResult`.

The raw file follows `contracts/transcript.schema.json`. The identity fields only the server knows
(`id`, `title`, `owner`, `recorded_at`, `source`, `created_at`, `updated_at`) are provisional, just
so the file validates; the server overwrites them on ingestion (docs/standards/api/jobs-transcricao.md).
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
    """Raw diarization label → `S<n>`, in order of first speech.

    Without diarization (no label), the map is `{None: "S1"}`: a single speaker.
    """
    mapping: dict[str | None, str] = {}
    for segment in sorted(result.segments, key=lambda s: s.start):
        if segment.speaker is not None and segment.speaker not in mapping:
            mapping[segment.speaker] = f"S{len(mapping) + 1}"
    return mapping or {None: "S1"}


def _segment_speakers(result: EngineResult, mapping: dict[str | None, str]) -> list[str]:
    """Speaker id per segment; with no label, it inherits the previous one (or the first that appears)."""
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


def build_transcript(  # noqa: PLR0913 — all keyword-only: the job metadata
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
    """Transcript in the contract schema, with `Locutor N` speakers and `person: null`.

    `offset_ms` is the silence preprocessing trimmed from the start: added to every segment and word
    time, the marks go back to those of the original audio, the one the user hears.
    `duration_ms` is the duration of that original; without it, the processed audio's plus the
    offset (the silence trimmed from the end is left out).
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
    """`speaker_embeddings.json`: vectors by transcript speaker id (`S<n>`).

    Diarization labels with no speech in the transcript are left out: there is no speaker for them.
    A vector with a non-finite component (NaN or infinity, which pyannote produces for speech that
    is too short) is left out too: the speaker stays without an embedding, and pgvector would refuse
    the whole ingestion.
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
