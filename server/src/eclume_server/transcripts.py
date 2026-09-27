"""Transcrições: ingestão da saída do worker GPU, forma JSON (schema v1) e export em Markdown."""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, func, insert, select, text, update

from eclume_server.db import tables as t
from eclume_server.pagination import iso
from eclume_server.pipeline import FAILED_STEP, record_gpu_steps, set_step
from eclume_server.problems import not_found
from eclume_server.serialize import Row, user_ref
from eclume_server.voice import capture_links, load_suggestions, platform_voice, restore_links, suggest

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.storage import Storage

SCHEMA_VERSION = "1.0"
_SPEAKER_ID = re.compile(r"^S[0-9]+$")
log = logging.getLogger(__name__)


# --- ingestão ---------------------------------------------------------------------------------


def _int(value: Any, default: int = 0) -> int:  # noqa: ANN401 — JSON do worker
    try:
        return max(0, round(float(value)))
    except (TypeError, ValueError):
        return default


def normalize_raw(raw: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, str]]:
    """Locutores e segmentos do `transcript.raw.json`, tolerante a campos ausentes.

    Devolve também o mapa id-do-worker → id `S<n>`: um id fora do padrão é renumerado na ordem em
    que aparece, e o mesmo mapa vale para os embeddings.
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
    """`(modelo, {S<n>: vetor})` do `speaker_embeddings.json`."""
    if not isinstance(document, dict):
        return "unknown", {}
    vectors = document.get("speaker_embeddings", document)
    model = str(document.get("embedding_model") or "unknown")
    result = {}
    for original, vector in vectors.items():
        if isinstance(vector, list) and vector and original in mapping:
            result[mapping[original]] = [float(x) for x in vector]
    return model, result


async def _store_embeddings(  # noqa: PLR0913, PLR0917 — o estado da ingestão passa explícito
    conn: AsyncConnection,
    storage: Storage,
    transcript_id: UUID,
    owner_id: UUID,
    embeddings_key: str | None,
    mapping: dict[str, str],
    *,
    keep: bool,
) -> tuple[str | None, dict[str, list[float]]]:
    """Grava os `speaker_embeddings` do job; devolve `(modelo, vetores)` gravados.

    A identificação por voz vale no momento da ingestão: um job enfileirado antes do desligamento
    não guarda o vetor, e o `speaker_embeddings.json` que ele produziu sai do bucket.
    """
    if not embeddings_key:
        return None, {}
    if not keep or not (await platform_voice(conn))["enabled"]:
        await storage.delete_keys([embeddings_key])
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


RECORDING_GONE = "gravação inexistente"


async def ingest(  # noqa: PLR0913 — os argumentos do job `ingest_transcript`; uma transação em sequência
    conn: AsyncConnection,
    storage: Storage,
    recording_id: UUID,
    *,
    transcript_key: str,
    embeddings_key: str | None,
    engine_info: dict[str, Any] | None,
) -> str:
    """Persiste a transcrição do job em aberto; idempotente por `(recording_id, revision)`.

    Roda com o papel de conexão (worker CPU). Devolve o que aconteceu, para o log.
    """
    recording = (
        (await conn.execute(select(t.recordings).where(t.recordings.c.id == recording_id).with_for_update()))
        .mappings()
        .first()
    )
    if recording is None:
        return RECORDING_GONE
    job = (
        (
            await conn.execute(
                select(t.transcription_jobs)
                .where(t.transcription_jobs.c.recording_id == recording_id)
                .order_by(t.transcription_jobs.c.revision.desc())
                .limit(1)
                .with_for_update()
            )
        )
        .mappings()
        .first()
    )
    if job is None or job["state"] not in {"queued", "running"}:
        return "sem job em aberto (já ingerido?)"

    raw = await storage.read_json(transcript_key)
    speakers, segments, mapping = normalize_raw(raw)
    engine_info = engine_info or {}
    options = job["options"] or {}
    language = raw.get("language") or recording["language"] or options.get("language") or "pt"
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
    # Retranscrever não desfaz o que alguém confirmou: os vínculos voltam pela sobreposição de fala.
    if old_links:
        await restore_links(conn, transcript_id, old_links, segments)
    if vectors:
        dims = {len(vector) for vector in vectors.values()}
        if len(dims) == 1:
            await suggest(conn, owner, transcript_id, model, dims.pop())

    await conn.execute(
        update(t.transcription_jobs)
        .where(t.transcription_jobs.c.id == job["id"])
        .values(state="succeeded", finished_at=now, attempts=job["attempts"] + 1, engine_info=engine_info)
    )
    await record_gpu_steps(conn, job, engine_info, now)
    await conn.execute(
        update(t.recordings)
        .where(t.recordings.c.id == recording_id)
        .values(
            status="transcribed",
            language=recording["language"] or language,
            duration_ms=recording["duration_ms"] or duration_ms,
            updated_at=now,
        )
    )
    return f"transcrição {transcript_id} gravada (revisão do job {job['revision']})"


async def fail(
    conn: AsyncConnection, recording_id: UUID, error_code: str, message: str, stage: str | None = None
) -> str:
    """Marca como falho o job em aberto e a gravação; job já concluído não muda.

    `stage` é a etapa do progresso do worker GPU em que a falha aconteceu: no download ou no
    pré-processamento, falha o pré-processamento; nas demais (ou sem ela), a transcrição.
    """
    now = datetime.now(UTC)
    job = (
        (
            await conn.execute(
                select(t.transcription_jobs)
                .where(t.transcription_jobs.c.recording_id == recording_id)
                .order_by(t.transcription_jobs.c.revision.desc())
                .limit(1)
                .with_for_update()
            )
        )
        .mappings()
        .first()
    )
    if job is None or job["state"] not in {"queued", "running"}:
        return "sem job em aberto"
    await conn.execute(
        update(t.transcription_jobs)
        .where(t.transcription_jobs.c.id == job["id"])
        .values(
            state="failed",
            error_code=error_code or "engine_error",
            error_message=message or "",
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
        started_at=job["started_at"] or job["queued_at"],
        finished_at=now,
    )
    return f"job {job['id']} falhou: {error_code}"


# --- leitura ----------------------------------------------------------------------------------


def transcript_select() -> Any:  # noqa: ANN401 — Select do SQLAlchemy
    """Transcrições do usuário (sob a RLS) com os campos que vêm da gravação e do dono."""
    r = t.recordings.c
    return select(
        t.transcripts,
        r.title,
        r.recorded_at,
        r.source,
        r.content_hash,
        r.tags,
        r.owner_id,
        t.users.c.name.label("owner_name"),
    ).select_from(
        t.transcripts.join(t.recordings, r.id == t.transcripts.c.recording_id).join(t.users, t.users.c.id == r.owner_id)
    )


def speakers_select() -> Any:  # noqa: ANN401 — Select do SQLAlchemy
    """Locutores com o nome da pessoa ligada (sob a RLS)."""
    return select(t.speakers, t.people.c.name.label("person_name")).select_from(
        t.speakers.outerjoin(t.people, t.people.c.id == t.speakers.c.person_id)
    )


def speaker_json(row: Row) -> dict[str, Any]:
    """Schema `Speaker`, de uma linha de `speakers_select` com as `suggestions` de `load_suggestions`."""
    person = None
    if row["person_id"] is not None:
        person = {"id": str(row["person_id"]), "name": row["person_name"]}
    return {
        "id": row["speaker_id"],
        "label": row["label"],
        "person": person,
        "suggestions": [] if person else list(row.get("suggestions") or []),
        "talk_ms": row["talk_ms"],
    }


async def load_speakers(conn: AsyncConnection, transcript_ids: list[UUID]) -> dict[UUID, list[Row]]:
    """Locutores de cada transcrição, na ordem da transcrição, com as sugestões por voz pendentes."""
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
    """Transcrição do usuário completa (schema v1), ou 404."""
    row = (await conn.execute(transcript_select().where(t.transcripts.c.id == transcript_id))).mappings().first()
    if row is None:
        raise not_found("Transcrição inexistente ou sem acesso.")
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
    """Schema `Segment`; `words` só quando pedido."""
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
    }


def transcript_json(row: Row, speakers: list[Row], segments: list[Row], *, words: bool) -> dict[str, Any]:
    """Corpo de `contracts/transcript.schema.json`."""
    body = {"schema_version": SCHEMA_VERSION, **summary_json(row, speakers)}
    if row["engine"]:
        body["engine"] = row["engine"]
    body["segments"] = [segment_json(s, words=words) for s in segments]
    return body


# --- edição -----------------------------------------------------------------------------------


async def editable_transcript(conn: AsyncConnection, transcript_id: UUID) -> Row:
    """Transcrição do usuário (sob a RLS, só o dono a vê), ou 404."""
    row = (await conn.execute(transcript_select().where(t.transcripts.c.id == transcript_id))).mappings().first()
    if row is None:
        raise not_found("Transcrição inexistente ou sem acesso.")
    return row


async def bump_revision(conn: AsyncConnection, transcript_id: UUID) -> None:
    """Toda edição sobe a `revision` e o `updated_at` (o `?since=` dos clientes enxerga)."""
    await conn.execute(
        update(t.transcripts)
        .where(t.transcripts.c.id == transcript_id)
        .values(revision=t.transcripts.c.revision + 1, updated_at=datetime.now(UTC))
    )


async def recompute_talk(conn: AsyncConnection, transcript_id: UUID, speaker_ids: set[str]) -> None:
    """Recalcula `talk_ms` dos locutores dados a partir dos segmentos."""
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
    """Export `format=md`: frontmatter YAML e uma linha `**Nome** [HH:MM:SS]: texto` por segmento."""

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
