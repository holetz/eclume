"""Transcripts: ingestion of the GPU worker output, JSON shape (schema v1) and Markdown export."""

from __future__ import annotations

import json
import logging
import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, func, insert, select, text, update

from eclume_server.db import tables as t
from eclume_server.pagination import iso
from eclume_server.pipeline import FAILED_STEP, gpu_started, record_gpu_steps, set_step
from eclume_server.problems import not_found
from eclume_server.queue import AUTO_LANGUAGE, DEFAULT_LANGUAGE
from eclume_server.serialize import Row, requester_name, user_ref
from eclume_server.speaker_naming import gate as gate_speakers
from eclume_server.voice import (
    capture_links,
    keeps_samples,
    load_suggestions,
    platform_voice,
    restore_links,
    suggest,
)

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.storage import Storage

SCHEMA_VERSION = "1.2"
_SPEAKER_ID = re.compile(r"^S[0-9]+$")
log = logging.getLogger(__name__)


# --- ingestion --------------------------------------------------------------------------------


def _int(value: Any, default: int = 0) -> int:  # noqa: ANN401 — JSON do worker
    try:
        return max(0, round(float(value)))
    except (TypeError, ValueError):
        return default


def normalize_raw(raw: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, str]]:
    """Speakers and segments of `transcript.raw.json`, tolerant of missing fields.

    Also returns the worker-id → `S<n>` id map: an id outside the pattern is renumbered in the order
    it appears, and the same map applies to the embeddings.
    """
    mapping: dict[str, str] = {}
    labels: dict[str, str] = {}

    def speaker_id(original: Any) -> str:  # noqa: ANN401
        key = str(original) if original is not None else "S1"
        if key not in mapping:
            mapping[key] = key if _SPEAKER_ID.match(key) and key not in mapping.values() else f"S{len(mapping) + 1}"
        return mapping[key]

    for speaker in raw.get("speakers") or []:
        sid = speaker_id(speaker.get("id"))
        labels[sid] = speaker.get("label") or f"Locutor {sid[1:]}"

    segments = []
    for index, segment in enumerate(raw.get("segments") or []):
        start = _int(segment.get("start_ms"))
        body: dict[str, Any] = {
            "segment_id": str(segment.get("id") or f"seg-{index + 1}"),
            "speaker_id": speaker_id(segment.get("speaker_id")),
            "start_ms": start,
            "end_ms": max(start, _int(segment.get("end_ms"), start)),
            "text": str(segment.get("text") or "").strip(),
            "confidence": segment.get("confidence"),
            "words": segment.get("words"),
        }
        segments.append(body)
    segments.sort(key=lambda s: (s["start_ms"], s["end_ms"]))

    talk: dict[str, int] = {}
    for segment in segments:
        talk[segment["speaker_id"]] = talk.get(segment["speaker_id"], 0) + segment["end_ms"] - segment["start_ms"]
    ordered = list(labels) + [sid for sid in dict.fromkeys(s["speaker_id"] for s in segments) if sid not in labels]
    speakers = [
        {"speaker_id": sid, "label": labels.get(sid, f"Locutor {sid[1:]}"), "talk_ms": talk.get(sid, 0)}
        for sid in ordered
    ]
    return speakers, segments, mapping


def _embeddings(document: Any, mapping: dict[str, str]) -> tuple[str, dict[str, list[float]]]:  # noqa: ANN401
    """`(model, {S<n>: vector})` from `speaker_embeddings.json`.

    A vector with a non-finite component (NaN or infinity, from too-short speech) is left out:
    pgvector would refuse it and undo the whole ingestion. A new worker no longer writes it; this
    covers an old worker and JSON already in the bucket.
    """
    if not isinstance(document, dict):
        return "unknown", {}
    vectors = document.get("speaker_embeddings", document)
    model = str(document.get("embedding_model") or "unknown")
    result = {}
    for original, vector in vectors.items():
        if isinstance(vector, list) and vector and original in mapping:
            values = [float(x) for x in vector]
            if all(math.isfinite(x) for x in values):
                result[mapping[original]] = values
            else:
                log.warning("speaker embedding %s with a non-finite value discarded", original)
    return model, result


async def _store_embeddings(  # noqa: PLR0913, PLR0917 — the ingestion state is passed explicitly
    conn: AsyncConnection,
    storage: Storage,
    transcript_id: UUID,
    owner_id: UUID,
    embeddings_key: str | None,
    mapping: dict[str, str],
    *,
    keep: bool,
) -> tuple[str | None, dict[str, list[float]]]:
    """Write the job's `speaker_embeddings`; return the `(model, vectors)` written.

    Voice identification and the account preference apply at ingestion time: a job queued before
    the switch-off (of the platform or the account) does not keep the vector. Whether the vector is
    kept or discarded, `speaker_embeddings.json` (biometrics) enters the bucket deletion queue in
    this same transaction: the vector lives only in the database.
    """
    if not embeddings_key:
        return None, {}
    await conn.execute(insert(t.storage_deletions).values(key=embeddings_key))
    if not keep or not (await platform_voice(conn))["enabled"] or not await keeps_samples(conn, owner_id):
        return None, {}
    model, vectors = _embeddings(await storage.read_json(embeddings_key), mapping)
    for sid, vector in vectors.items():
        await conn.execute(
            text(
                "INSERT INTO speaker_embeddings (transcript_id, owner_id, speaker_id, model, embedding)"
                " VALUES (:transcript, :owner, :speaker, :model, CAST(:vector AS vector))"
            ),
            {
                "transcript": transcript_id,
                "owner": owner_id,
                "speaker": sid,
                "model": model,
                "vector": json.dumps(vector),
            },
        )
    return model, vectors


@dataclass(frozen=True)
class Ingested:
    """The ingestion outcome: the log line and whether the transcript was written now.

    Only what was written goes on to the agent chain (and closed the job); `gone` says the
    recording was deleted.
    """

    message: str
    persisted: bool = False
    gone: bool = False
    revision: int | None = None
    # The `speakers` step stopped the chain: the account requires naming the speakers and someone is missing.
    waiting: bool = False


@dataclass(frozen=True)
class Failed:
    """O desfecho de `fail`: a linha do log e se o job foi fechado agora."""

    message: str
    closed: bool = False


async def _lock_open_job(
    conn: AsyncConnection, recording_id: UUID, revision: int | None
) -> tuple[Row | None, Row | None]:
    """Lock the recording and only then read the revision's job (without a revision, the most recent).

    Two statements: under READ COMMITTED, whoever waited for the recording lock sees the job already
    updated by whoever held it. Returns `(recording, job)`; the job comes only if it is open.
    """
    recording = (
        (await conn.execute(select(t.recordings).where(t.recordings.c.id == recording_id).with_for_update()))
        .mappings()
        .first()
    )
    if recording is None:
        return None, None
    jobs = t.transcription_jobs
    query = select(jobs).where(jobs.c.recording_id == recording_id)
    if revision is None:
        query = query.order_by(jobs.c.revision.desc()).limit(1)
    else:
        query = query.where(jobs.c.revision == revision)
    job = (await conn.execute(query.with_for_update())).mappings().first()
    if job is None or job["state"] not in {"queued", "running"}:
        return recording, None
    return recording, job


def _obsolete(revision: int | None) -> str:
    return f"mensagem obsoleta: sem job em aberto da revisão {revision or 'mais recente'}"


async def ingest(  # noqa: PLR0913 — the arguments of the `ingest_transcript` job; one transaction in sequence
    conn: AsyncConnection,
    storage: Storage,
    recording_id: UUID,
    *,
    transcript_key: str,
    embeddings_key: str | None,
    engine_info: dict[str, Any] | None,
    revision: int | None = None,
) -> Ingested:
    """Persist the transcript of the revision's job; idempotent by `(recording_id, revision)`.

    Runs with the connection role (CPU worker). Without `revision` (old worker), the most recent job
    applies. A job already completed or failed (by the reaper, for example), or from a revision that
    is no longer open, is not written: the message is stale.
    """
    recording, job = await _lock_open_job(conn, recording_id, revision)
    if recording is None:
        return Ingested("gravação inexistente", gone=True)
    if job is None:
        return Ingested(_obsolete(revision))

    raw = await storage.read_json(transcript_key)
    speakers, segments, mapping = normalize_raw(raw)
    engine_info = engine_info or {}
    options = job["options"] or {}
    # `auto` is a request, never a result: the detected one applies and, without it, the resolved default.
    requested = None if recording["language"] == AUTO_LANGUAGE else recording["language"]
    language = raw.get("language") or requested or options.get("language") or DEFAULT_LANGUAGE
    duration_ms = (
        _int(raw.get("duration_ms"), 0) or recording["duration_ms"] or max((s["end_ms"] for s in segments), default=0)
    )
    engine = {
        "name": engine_info.get("engine") or options.get("engine") or "unknown",
        "model": engine_info.get("model") or options.get("model") or "unknown",
        "diarization_model": engine_info.get("diarization_model"),
    }
    now = datetime.now(UTC)

    existing = (
        (await conn.execute(select(t.transcripts).where(t.transcripts.c.recording_id == recording_id)))
        .mappings()
        .first()
    )
    values = {"language": language, "duration_ms": duration_ms, "engine": engine, "updated_at": now}
    old_links = []
    if existing is None:
        transcript_id = (
            await conn.execute(
                insert(t.transcripts)
                .values(owner_id=recording["owner_id"], recording_id=recording_id, revision=job["revision"], **values)
                .returning(t.transcripts.c.id)
            )
        ).scalar_one()
    else:
        transcript_id = existing["id"]
        old_links = await capture_links(conn, transcript_id)
        revision = max(job["revision"], existing["revision"] + 1)
        await conn.execute(
            update(t.transcripts).where(t.transcripts.c.id == transcript_id).values(revision=revision, **values)
        )
        for table in (t.speakers, t.segments):
            await conn.execute(delete(table).where(table.c.transcript_id == transcript_id))
        await conn.execute(text("DELETE FROM speaker_embeddings WHERE transcript_id = :id"), {"id": transcript_id})

    owner = recording["owner_id"]
    if speakers:
        await conn.execute(
            insert(t.speakers),
            [{"transcript_id": transcript_id, "owner_id": owner, "position": i, **s} for i, s in enumerate(speakers)],
        )
    if segments:
        await conn.execute(
            insert(t.segments),
            [{"transcript_id": transcript_id, "owner_id": owner, "position": i, **s} for i, s in enumerate(segments)],
        )
    model, vectors = await _store_embeddings(
        conn, storage, transcript_id, owner, embeddings_key, mapping, keep=bool(options.get("embeddings"))
    )
    # Retranscribing does not undo what someone confirmed: the links come back through speech overlap.
    if old_links:
        await restore_links(conn, transcript_id, old_links, segments)
    if vectors:
        dims = {len(vector) for vector in vectors.values()}
        if len(dims) == 1:
            await suggest(conn, owner, transcript_id, model, dims.pop())

    await conn.execute(
        update(t.transcription_jobs)
        .where(t.transcription_jobs.c.id == job["id"])
        .values(
            state="succeeded",
            started_at=gpu_started(engine_info, job["started_at"] or job["queued_at"]),
            finished_at=now,
            attempts=job["attempts"] + 1,
            engine_info=engine_info,
        )
    )
    await record_gpu_steps(conn, job, engine_info, now)
    # After the restored links and the voice attribution: someone is missing, the chain stops here.
    waiting = await gate_speakers(conn, {"id": recording_id, "owner_id": owner}, job["revision"], transcript_id)
    await conn.execute(
        update(t.recordings)
        .where(t.recordings.c.id == recording_id)
        .values(
            status="transcribed",
            language=requested or language,
            duration_ms=recording["duration_ms"] or duration_ms,
            updated_at=now,
        )
    )
    return Ingested(
        f"transcrição {transcript_id} gravada (revisão do job {job['revision']})",
        persisted=True,
        revision=job["revision"],
        waiting=waiting,
    )


async def fail(  # noqa: PLR0913 — the arguments of the `transcription_failed` job and the revision
    conn: AsyncConnection,
    recording_id: UUID,
    error_code: str,
    message: str,
    stage: str | None = None,
    *,
    revision: int | None = None,
    started_at: str | None = None,
) -> Failed:
    """Mark the revision's job (without one, the most recent) and the recording as failed, if open.

    Locks the recording before the job, in the same order as ingestion. `stage` is the GPU worker
    progress stage where the failure happened: in the download or in preprocessing, preprocessing
    fails; in the others (or without one), transcription. `started_at` is the job's start on the
    GPU worker (from the progress hash); without it, the one already written or the queue entry applies.
    """
    now = datetime.now(UTC)
    _, job = await _lock_open_job(conn, recording_id, revision)
    if job is None:
        return Failed(_obsolete(revision))
    # The worker's clock may be ahead: the start never goes past the end.
    started = min(gpu_started({"started_at": started_at}, job["started_at"] or job["queued_at"]), now)
    await conn.execute(
        update(t.transcription_jobs)
        .where(t.transcription_jobs.c.id == job["id"])
        .values(
            state="failed",
            error_code=error_code or "engine_error",
            error_message=message or "",
            started_at=started,
            finished_at=now,
            attempts=job["attempts"] + 1,
        )
    )
    await conn.execute(
        update(t.recordings).where(t.recordings.c.id == recording_id).values(status="failed", updated_at=now)
    )
    await set_step(
        conn,
        {"id": recording_id, "owner_id": job["owner_id"]},
        job["revision"],
        FAILED_STEP.get(stage or "", "transcription"),
        "failed",
        error=(error_code or "engine_error", message or ""),
        started_at=started,
        finished_at=now,
    )
    return Failed(f"job {job['id']} falhou: {error_code}", closed=True)


# --- leitura ----------------------------------------------------------------------------------


def transcript_select() -> Any:  # noqa: ANN401 — Select do SQLAlchemy
    """The user's transcripts (under RLS) with the fields that come from the recording and the owner."""
    r = t.recordings.c
    return select(
        t.transcripts,
        r.title,
        r.recorded_at,
        r.source,
        r.content_hash,
        r.tags,
        r.kind,
        r.recorded_at_source,
        r.owner_id,
        requester_name().label("owner_name"),
    ).select_from(t.transcripts.join(t.recordings, r.id == t.transcripts.c.recording_id))


def speakers_select() -> Any:  # noqa: ANN401 — Select do SQLAlchemy
    """Locutores com o nome da pessoa ligada (sob a RLS)."""
    return select(t.speakers, t.people.c.name.label("person_name")).select_from(
        t.speakers.outerjoin(t.people, t.people.c.id == t.speakers.c.person_id)
    )


def speaker_json(row: Row) -> dict[str, Any]:
    """Schema `Speaker`, from a `speakers_select` row with the `suggestions` from `load_suggestions`."""
    person = None
    if row["person_id"] is not None:
        person = {"id": str(row["person_id"]), "name": row["person_name"]}
    return {
        "id": row["speaker_id"],
        "label": row["label"],
        "person": person,
        "suggestions": [] if person else list(row.get("suggestions") or []),
        "auto_score": None if person is None or row.get("auto_score") is None else round(float(row["auto_score"]), 4),
        "talk_ms": row["talk_ms"],
    }


async def load_speakers(conn: AsyncConnection, transcript_ids: list[UUID]) -> dict[UUID, list[Row]]:
    """Speakers of each transcript, in transcript order, with the pending voice suggestions."""
    rows = (
        await conn.execute(
            speakers_select()
            .where(t.speakers.c.transcript_id.in_(transcript_ids))
            .order_by(t.speakers.c.transcript_id, t.speakers.c.position)
        )
    ).mappings()
    suggestions = await load_suggestions(conn, transcript_ids)
    grouped: dict[UUID, list[Row]] = {transcript_id: [] for transcript_id in transcript_ids}
    for row in rows:
        key = (row["transcript_id"], row["speaker_id"])
        grouped[row["transcript_id"]].append({**row, "suggestions": suggestions.get(key, [])})
    return grouped


async def load_transcript(conn: AsyncConnection, transcript_id: UUID, *, words: bool) -> dict[str, Any]:
    """The user's full transcript (schema v1), or 404."""
    row = (await conn.execute(transcript_select().where(t.transcripts.c.id == transcript_id))).mappings().first()
    if row is None:
        raise not_found("Transcript does not exist or is not accessible.")
    speakers = (await load_speakers(conn, [transcript_id]))[transcript_id]
    segments = (
        (
            await conn.execute(
                select(t.segments).where(t.segments.c.transcript_id == transcript_id).order_by(t.segments.c.position)
            )
        )
        .mappings()
        .all()
    )
    return transcript_json(row, speakers, list(segments), words=words)


def segment_json(row: Row, *, words: bool) -> dict[str, Any]:
    """Schema `Segment`; `words` only when requested."""
    body: dict[str, Any] = {
        "id": row["segment_id"],
        "speaker_id": row["speaker_id"],
        "start_ms": row["start_ms"],
        "end_ms": row["end_ms"],
        "text": row["text"],
    }
    if row["confidence"] is not None:
        body["confidence"] = row["confidence"]
    if words and row["words"] is not None:
        body["words"] = row["words"]
    return body


def summary_json(row: Row, speakers: list[Row]) -> dict[str, Any]:
    """Schema `TranscriptSummary`."""
    return {
        "id": str(row["id"]),
        "recording_id": str(row["recording_id"]),
        "title": row["title"],
        "language": row["language"],
        "recorded_at": iso(row["recorded_at"]),
        "duration_ms": row["duration_ms"],
        "source": row["source"],
        "content_hash": row["content_hash"],
        "revision": row["revision"],
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
        "owner": user_ref(row["owner_id"], row["owner_name"]),
        "speakers": [speaker_json(s) for s in speakers],
        "tags": list(row["tags"]),
        "kind": row["kind"],
        "recorded_at_source": row["recorded_at_source"],
    }


def transcript_json(row: Row, speakers: list[Row], segments: list[Row], *, words: bool) -> dict[str, Any]:
    """Corpo de `contracts/transcript.schema.json`."""
    body = {"schema_version": SCHEMA_VERSION, **summary_json(row, speakers)}
    if row["engine"]:
        body["engine"] = row["engine"]
    body["segments"] = [segment_json(s, words=words) for s in segments]
    return body


# --- editing ----------------------------------------------------------------------------------


async def editable_transcript(conn: AsyncConnection, transcript_id: UUID) -> Row:
    """The user's transcript (under RLS, only the owner sees it), or 404."""
    row = (await conn.execute(transcript_select().where(t.transcripts.c.id == transcript_id))).mappings().first()
    if row is None:
        raise not_found("Transcript does not exist or is not accessible.")
    return row


async def bump_revision(conn: AsyncConnection, transcript_id: UUID) -> None:
    """Every edit bumps `revision` and `updated_at` (the clients' `?since=` sees it)."""
    now = datetime.now(UTC)
    recording_id = (
        await conn.execute(
            update(t.transcripts)
            .where(t.transcripts.c.id == transcript_id)
            .values(revision=t.transcripts.c.revision + 1, updated_at=now)
            .returning(t.transcripts.c.recording_id)
        )
    ).scalar_one_or_none()
    if recording_id is not None:
        # The desktop synced folder lists by `recordings.updated_at`: without this, fixing a segment
        # or renaming a speaker would never reach the `.jsonl`.
        await conn.execute(update(t.recordings).where(t.recordings.c.id == recording_id).values(updated_at=now))


async def recompute_talk(conn: AsyncConnection, transcript_id: UUID, speaker_ids: set[str]) -> None:
    """Recompute `talk_ms` of the given speakers from the segments."""
    sg = t.segments.c
    talk = (
        select(func.coalesce(func.sum(sg.end_ms - sg.start_ms), 0))
        .where(sg.transcript_id == transcript_id, sg.speaker_id == t.speakers.c.speaker_id)
        .scalar_subquery()
    )
    await conn.execute(
        update(t.speakers)
        .where(t.speakers.c.transcript_id == transcript_id, t.speakers.c.speaker_id.in_(speaker_ids))
        .values(talk_ms=talk)
    )


def _hms(ms: int) -> str:
    seconds = ms // 1000
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def render_markdown(transcript: dict[str, Any]) -> str:
    """Export `format=md`: YAML frontmatter and one `**Nome** [HH:MM:SS]: texto` line per segment."""

    def q(value: object) -> str:
        return json.dumps(value, ensure_ascii=False)

    def name(speaker: dict[str, Any]) -> str:
        return speaker["person"]["name"] if speaker["person"] else speaker["label"]

    names = {speaker["id"]: name(speaker) for speaker in transcript["speakers"]}
    lines = ["---"]
    lines.extend(
        f"{key}: {q(transcript[key])}"
        for key in ("id", "title", "recorded_at", "language", "duration_ms", "source", "revision")
    )
    lines.append("speakers:")
    for speaker in transcript["speakers"]:
        lines.append(f"  - id: {q(speaker['id'])}")
        lines.append(f"    label: {q(speaker['label'])}")
        lines.append(f"    person: {q(speaker['person']['name'] if speaker['person'] else None)}")
    lines.append("---")
    for segment in transcript["segments"]:
        speaker = names.get(segment["speaker_id"], segment["speaker_id"])
        lines.extend(("", f"**{speaker}** [{_hms(segment['start_ms'])}]: {segment['text']}"))
    return "\n".join(lines) + "\n"


def transcript_text_window(
    document: dict[str, Any], start_ms: int = 0, end_ms: int | None = None, max_chars: int = 60_000
) -> tuple[str, int | None]:
    """Utterances `[mm:ss] Locutor: fala` between `start_ms` and `end_ms`, up to `max_chars` characters.

    Returns the text and the `start_ms` of the first utterance left out by the ceiling (`None` when none is left).
    """
    names = {s["id"]: s["person"]["name"] if s["person"] else s["label"] for s in document["speakers"]}
    lines: list[str] = []
    size = 0
    for segment in document["segments"]:
        if segment["start_ms"] < start_ms or (end_ms is not None and segment["start_ms"] >= end_ms):
            continue
        seconds = segment["start_ms"] // 1000
        line = f"[{seconds // 60:02d}:{seconds % 60:02d}] {names.get(segment['speaker_id'], segment['speaker_id'])}: "
        line += segment["text"]
        if lines and size + len(line) + 1 > max_chars:
            return "\n".join(lines), segment["start_ms"]
        lines.append(line)
        size += len(line) + 1
    return "\n".join(lines), None
