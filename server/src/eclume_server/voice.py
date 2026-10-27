"""Voice identification: voiceprint samples, comparison at ingestion and suggestions.

Rules in docs/standards/code/identificacao-por-voz.md. A person's voiceprint is the set of their
samples (`voice_samples`), one per confirmed speaker; comparing is the cosine between the new
speaker's embedding and the normalized centroid of those samples, only among the transcript
owner's people. Nothing is compared or kept as a sample with voice identification switched off on
the platform; accepting the notice at sign-up covers the consent of whoever the user records.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import and_, delete, distinct, func, insert, literal, select, text, update

from eclume_server.db import tables as t

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.auth import Principal

# Calibration in docs/project/calibracao-voz.md: default threshold, minimum speech to compare a speaker
# and for it to become a sample. Below that the embedding is too noisy.
DEFAULT_THRESHOLD = 0.55
MIN_COMPARE_TALK_MS = 10_000
MIN_SAMPLE_TALK_MS = 10_000
MAX_SUGGESTIONS = 3
# Automatic attribution: the account's default threshold (calibracao-voz.md: FPR ~0.05% at 0.70), the
# accepted range and the minimum margin between the 1st and 2nd candidate people of the same speaker;
# without the margin, it only suggests.
DEFAULT_AUTO_THRESHOLD = 0.75
MIN_AUTO_THRESHOLD = 0.5
MAX_AUTO_THRESHOLD = 0.99
AUTO_MARGIN = 0.05
# Retranscription: the new speaker inherits the old one's link when the speech of both overlaps by at
# least this fraction, in both directions.
RESTORE_OVERLAP = 0.5

VOICE_DEFAULTS: dict[str, Any] = {"enabled": False, "suggestion_threshold": DEFAULT_THRESHOLD}


def voice_settings(block: dict[str, Any] | None) -> dict[str, Any]:
    """The `voice_identification` block (`enabled`, `suggestion_threshold`), with the defaults."""
    block = block or {}
    return {key: block.get(key, default) for key, default in VOICE_DEFAULTS.items()}


async def platform_voice(conn: AsyncConnection) -> dict[str, Any]:
    """The platform's voice configuration (readable under RLS by any user)."""
    return voice_settings((await conn.execute(select(t.platform_settings.c.voice_identification))).scalar())


# --- amostras -----------------------------------------------------------------------------------

_ADD_SAMPLE = text(
    """
    INSERT INTO voice_samples (transcript_id, speaker_id, owner_id, person_id, model, embedding, talk_ms, created_by)
    SELECT e.transcript_id, e.speaker_id, e.owner_id, sp.person_id, e.model, e.embedding, sp.talk_ms, :actor
    FROM speaker_embeddings e
    JOIN speakers sp ON sp.transcript_id = e.transcript_id AND sp.speaker_id = e.speaker_id
    JOIN transcripts tr ON tr.id = e.transcript_id
    JOIN recordings rec ON rec.id = tr.recording_id
    CROSS JOIN platform_settings o
    WHERE e.transcript_id = :transcript AND e.speaker_id = :speaker
      AND sp.person_id IS NOT NULL AND sp.auto_score IS NULL
      AND (o.voice_identification ->> 'enabled')::boolean
      AND sp.talk_ms >= :min_talk
      AND rec.audio_deleted_at IS NULL
    ON CONFLICT (transcript_id, speaker_id) DO NOTHING
    RETURNING person_id
    """
)


async def add_sample(conn: AsyncConnection, transcript_id: UUID, speaker_id: str, actor_id: UUID | None) -> bool:
    """Keep the speaker (linked and confirmed) as a sample of the person, with voice identification on.

    A link the voice made on its own (`auto_score`) does not go in: only a confirmation reinforces the
    voiceprint. A recording without audio (deleted by retention) does not yield a new sample either.
    """
    params = {"transcript": transcript_id, "speaker": speaker_id, "actor": actor_id, "min_talk": MIN_SAMPLE_TALK_MS}
    return (await conn.execute(_ADD_SAMPLE, params)).first() is not None


# --- ingestion: preserved links and comparison --------------------------------------------------


@dataclass(frozen=True)
class OldLink:
    """A speaker's link before retranscription, with its speech."""

    speaker_id: str
    person_id: UUID
    label: str
    auto_score: float | None
    spans: list[tuple[int, int]]


async def capture_links(conn: AsyncConnection, transcript_id: UUID) -> list[OldLink]:
    """The transcript's linked speakers and the speech intervals of each (before deleting)."""
    sp, sg = t.speakers.c, t.segments.c
    linked = (
        await conn.execute(
            select(sp.speaker_id, sp.person_id, sp.label, sp.auto_score).where(
                sp.transcript_id == transcript_id, sp.person_id.is_not(None)
            )
        )
    ).all()
    if not linked:
        return []
    spans: dict[str, list[tuple[int, int]]] = {}
    rows = await conn.execute(
        select(sg.speaker_id, sg.start_ms, sg.end_ms).where(
            sg.transcript_id == transcript_id, sg.speaker_id.in_([row.speaker_id for row in linked])
        )
    )
    for row in rows:
        spans.setdefault(row.speaker_id, []).append((row.start_ms, row.end_ms))
    return [
        OldLink(row.speaker_id, row.person_id, row.label, row.auto_score, spans.get(row.speaker_id, []))
        for row in linked
    ]


def _merged(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    result: list[tuple[int, int]] = []
    for start, end in sorted(spans):
        if result and start <= result[-1][1]:
            result[-1] = (result[-1][0], max(result[-1][1], end))
        elif end > start:
            result.append((start, end))
    return result


def _overlap(a: list[tuple[int, int]], b: list[tuple[int, int]]) -> int:
    """Total intersection of two interval lists, already merged and sorted."""
    total, i, j = 0, 0, 0
    while i < len(a) and j < len(b):
        total += max(0, min(a[i][1], b[j][1]) - max(a[i][0], b[j][0]))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return total


def match_links(old: list[OldLink], new_segments: list[dict[str, Any]]) -> tuple[dict[str, OldLink], list[OldLink]]:
    """Match each old link with the new speaker of greatest speech overlap, one to one.

    Matches only with overlap ≥ `RESTORE_OVERLAP` of both speeches. Returns `({new: old}, lost)`.
    """
    new_spans: dict[str, list[tuple[int, int]]] = {}
    for segment in new_segments:
        new_spans.setdefault(segment["speaker_id"], []).append((segment["start_ms"], segment["end_ms"]))
    merged_new = {sid: _merged(spans) for sid, spans in new_spans.items()}
    talk_new = {sid: sum(end - start for start, end in spans) for sid, spans in merged_new.items()}
    candidates = []
    for link in old:
        spans = _merged(link.spans)
        talk_old = sum(end - start for start, end in spans)
        for sid, other in merged_new.items():
            shared = _overlap(spans, other)
            if talk_old and talk_new[sid] and shared >= RESTORE_OVERLAP * max(talk_old, talk_new[sid]):
                candidates.append((shared, link.speaker_id, sid, link))
    matched: dict[str, OldLink] = {}
    used_old: set[str] = set()
    for _, old_id, new_id, link in sorted(candidates, key=lambda c: -c[0]):
        if old_id not in used_old and new_id not in matched:
            matched[new_id] = link
            used_old.add(old_id)
    return matched, [link for link in old if link.speaker_id not in used_old]


async def restore_links(
    conn: AsyncConnection, transcript_id: UUID, old: list[OldLink], new_segments: list[dict[str, Any]]
) -> None:
    """Reapply to the new speakers the links confirmed before retranscription (connection role)."""
    matched, _ = match_links(old, new_segments)
    for new_id, link in matched.items():
        await conn.execute(
            update(t.speakers)
            .where(t.speakers.c.transcript_id == transcript_id, t.speakers.c.speaker_id == new_id)
            .values(person_id=link.person_id, label=link.label, auto_score=link.auto_score)
        )
        await add_sample(conn, transcript_id, new_id, None)


# Normalized centroid of each person's samples, of the same model and dimension; cosine with each
# speaker without a person and with enough speech. Only the transcript owner's people.
_COMPARE = text(
    """
    WITH prints AS (
        SELECT s.person_id, l2_normalize(avg(l2_normalize(s.embedding))) AS centroid, count(*) AS samples
        FROM voice_samples s
        WHERE s.owner_id = :owner
          AND s.model = :model AND vector_dims(s.embedding) = :dims
          AND s.transcript_id <> :transcript
        GROUP BY s.person_id
    ), linked AS (
        SELECT person_id FROM speakers WHERE transcript_id = :transcript AND person_id IS NOT NULL
    )
    SELECT e.speaker_id, pr.person_id, pr.samples,
           greatest(0, 1 - (l2_normalize(e.embedding) <=> pr.centroid)) AS score
    FROM speaker_embeddings e
    JOIN speakers sp ON sp.transcript_id = e.transcript_id AND sp.speaker_id = e.speaker_id
    CROSS JOIN prints pr
    WHERE e.transcript_id = :transcript AND e.model = :model
      AND sp.person_id IS NULL AND sp.talk_ms >= :min_talk
      AND pr.person_id NOT IN (SELECT person_id FROM linked)
    ORDER BY e.speaker_id, score DESC
    """
)


@dataclass(frozen=True)
class AutoPrefs:
    """The account preference: attribute on its own, and from which score."""

    enabled: bool
    threshold: float


async def auto_prefs(conn: AsyncConnection, user_id: UUID) -> AutoPrefs:
    """The user's automatic attribution preference (the default, if the account no longer exists)."""
    row = (
        await conn.execute(
            select(t.users.c.voice_auto_assign, t.users.c.voice_auto_threshold).where(t.users.c.id == user_id)
        )
    ).first()
    return (
        AutoPrefs(enabled=True, threshold=DEFAULT_AUTO_THRESHOLD) if row is None else AutoPrefs(row[0], float(row[1]))
    )


def pick_auto(rows: list[Any], threshold: float) -> dict[str, Any]:
    """Choose the `{speaker: row}` to attribute: 1st candidate ≥ threshold, with margin over the 2nd and no repeated person.

    `rows` comes sorted by speaker and by descending score. The margin (`AUTO_MARGIN`) avoids linking
    when two people have a voice similar to the speaker's; a person two speakers compete for goes to
    the one with the higher score.
    """
    by_speaker: dict[str, list[Any]] = {}
    for row in rows:
        by_speaker.setdefault(row.speaker_id, []).append(row)
    best = []
    for candidates in by_speaker.values():
        top = candidates[0]
        runner_up = candidates[1].score if len(candidates) > 1 else 0.0
        if top.score >= threshold and top.score - runner_up >= AUTO_MARGIN:
            best.append(top)
    chosen: dict[str, Any] = {}
    taken: set[UUID] = set()
    for row in sorted(best, key=lambda r: -r.score):
        if row.person_id not in taken:
            taken.add(row.person_id)
            chosen[row.speaker_id] = row
    return chosen


async def suggest(conn: AsyncConnection, owner_id: UUID, transcript_id: UUID, model: str, dims: int) -> int:
    """Compare the transcript's speakers with the voiceprints, link the high-confidence ones and suggest the rest.

    Runs at ingestion, with the connection role: filters the owner explicitly. With automatic
    attribution on for the account, a speaker scoring ≥ its threshold is linked to the person (and
    the label becomes their name) before the agent chain and the summary read the transcript; the
    others get suggestions above the platform threshold. Returns how many suggestions it wrote.
    """
    settings = await platform_voice(conn)
    if not settings["enabled"]:
        return 0
    threshold = float(settings["suggestion_threshold"])
    params = {
        "owner": owner_id,
        "transcript": transcript_id,
        "model": model,
        "dims": dims,
        "min_talk": MIN_COMPARE_TALK_MS,
    }
    rows = (await conn.execute(_COMPARE, params)).all()
    prefs = await auto_prefs(conn, owner_id)
    assigned = pick_auto(rows, prefs.threshold) if prefs.enabled else {}
    if assigned:
        names = dict(
            (
                await conn.execute(
                    select(t.people.c.id, t.people.c.name).where(
                        t.people.c.id.in_([row.person_id for row in assigned.values()])
                    )
                )
            ).all()
        )
        for speaker_id, row in assigned.items():
            await conn.execute(
                update(t.speakers)
                .where(t.speakers.c.transcript_id == transcript_id, t.speakers.c.speaker_id == speaker_id)
                .values(person_id=row.person_id, label=names[row.person_id], auto_score=min(1.0, float(row.score)))
            )
    taken_people = {row.person_id for row in assigned.values()}
    per_speaker: dict[str, int] = {}
    suggested = []
    for row in rows:
        if row.speaker_id in assigned or row.person_id in taken_people:
            continue
        if row.score >= threshold and per_speaker.get(row.speaker_id, 0) < MAX_SUGGESTIONS:
            per_speaker[row.speaker_id] = per_speaker.get(row.speaker_id, 0) + 1
            suggested.append(row)
    for row in suggested:
        await conn.execute(
            insert(t.speaker_suggestions).values(
                transcript_id=transcript_id,
                speaker_id=row.speaker_id,
                owner_id=owner_id,
                person_id=row.person_id,
                score=min(1.0, float(row.score)),
            )
        )
    return len(suggested)


# --- reading the suggestions ---------------------------------------------------------------------


async def load_suggestions(conn: AsyncConnection, transcript_ids: list[UUID]) -> dict[tuple[UUID, str], list[dict]]:
    """Pending suggestions for speakers without a person, by `(transcript, speaker)`, highest `score` first.

    With voice identification switched off on the platform, none appears.
    """
    if not transcript_ids:
        return {}
    ss, sp, pe = t.speaker_suggestions.c, t.speakers.c, t.people.c
    enabled = select(t.platform_settings.c.voice_identification["enabled"].as_boolean()).scalar_subquery()
    query = (
        select(ss.transcript_id, ss.speaker_id, ss.person_id, ss.score, pe.name)
        .select_from(
            t.speaker_suggestions.join(
                t.speakers, and_(sp.transcript_id == ss.transcript_id, sp.speaker_id == ss.speaker_id)
            ).join(t.people, pe.id == ss.person_id)
        )
        .where(
            ss.transcript_id.in_(transcript_ids),
            ss.status == "pending",
            sp.person_id.is_(None),
            func.coalesce(enabled, literal(value=False)),
        )
        .order_by(ss.transcript_id, ss.speaker_id, ss.score.desc())
    )
    grouped: dict[tuple[UUID, str], list[dict]] = {}
    for row in await conn.execute(query):
        grouped.setdefault((row.transcript_id, row.speaker_id), []).append(
            {"person": {"id": str(row.person_id), "name": row.name}, "score": round(float(row.score), 4)}
        )
    return grouped


# --- confirmar e recusar ------------------------------------------------------------------------


@dataclass(frozen=True)
class SpeakerKey:
    """A speaker of a transcript."""

    transcript_id: UUID
    speaker_id: str


async def on_link(conn: AsyncConnection, principal: Principal, key: SpeakerKey, new_person: UUID | None) -> None:
    """After the `PATCH` that changes the speaker's person: accept the suggestion and add the new sample.

    The previous person's sample already left through the `speakers_voice_relink` trigger. Sending
    the same person confirms the link the voice made on its own: the `PATCH` already cleared
    `auto_score`, and now the sample goes in.
    """
    if new_person is None:
        return
    actor_id = principal.user_id
    transcript_id, speaker_id = key.transcript_id, key.speaker_id
    ss = t.speaker_suggestions.c
    await conn.execute(
        update(t.speaker_suggestions)
        .where(
            ss.transcript_id == transcript_id,
            ss.speaker_id == speaker_id,
            ss.person_id == new_person,
            ss.status == "pending",
        )
        .values(status="accepted", decided_by=actor_id, decided_at=datetime.now(UTC))
    )
    await add_sample(conn, transcript_id, speaker_id, actor_id)


async def reject(conn: AsyncConnection, principal: Principal, key: SpeakerKey, person_id: UUID) -> bool:
    """Mark the pending suggestion as rejected; `False` if there was none."""
    transcript_id, speaker_id = key.transcript_id, key.speaker_id
    ss = t.speaker_suggestions.c
    result = await conn.execute(
        update(t.speaker_suggestions)
        .where(
            ss.transcript_id == transcript_id,
            ss.speaker_id == speaker_id,
            ss.person_id == person_id,
            ss.status == "pending",
        )
        .values(status="rejected", decided_by=principal.user_id, decided_at=datetime.now(UTC))
    )
    return result.rowcount > 0


async def keeps_samples(conn: AsyncConnection, user_id: UUID) -> bool:
    """Whether the account keeps voice samples (the default, if the account no longer exists)."""
    query = select(t.users.c.voice_keep_samples).where(t.users.c.id == user_id)
    return (await conn.execute(query)).scalar() is not False


async def voice_counts(conn: AsyncConnection, owner_id: UUID) -> tuple[int, int]:
    """`(amostras, pessoas com impressão)` da conta."""
    vs = t.voice_samples.c
    query = select(func.count(), func.count(distinct(vs.person_id))).where(vs.owner_id == owner_id)
    samples, people = (await conn.execute(query)).one()
    return samples, people


async def purge_account(conn: AsyncConnection, owner_id: UUID) -> None:
    """The account stops keeping voice: delete its samples, vectors and pending suggestions.

    Runs under the owner's RLS; the explicit owner filter also holds with the connection role. The
    bucket's `speaker_embeddings.json` files leave in the CPU worker, after the commit.
    """
    await conn.execute(delete(t.speaker_embeddings).where(t.speaker_embeddings.c.owner_id == owner_id))
    await conn.execute(delete(t.voice_samples).where(t.voice_samples.c.owner_id == owner_id))
    ss = t.speaker_suggestions.c
    await conn.execute(delete(t.speaker_suggestions).where(ss.owner_id == owner_id, ss.status == "pending"))


async def purge_embeddings(conn: AsyncConnection) -> tuple[int, int]:
    """Delete the `speaker_embeddings` and pending suggestions of the whole platform (connection role)."""
    embeddings = await conn.execute(delete(t.speaker_embeddings))
    suggestions = await conn.execute(delete(t.speaker_suggestions).where(t.speaker_suggestions.c.status == "pending"))
    return embeddings.rowcount, suggestions.rowcount


async def forget(conn: AsyncConnection, person_id: UUID) -> tuple[int, int]:
    """Delete the samples, pending suggestions and vectors of the person's speakers, under the owner's RLS.

    The speaker ↔ person link stays; without the vector, relinking one of those speakers does not
    recreate the sample, and only a retranscription recreates it (holetz/eclume#97, the spec's
    recommendation until the owner decides).
    """
    await conn.execute(
        text(
            "DELETE FROM speaker_embeddings se USING speakers s"
            " WHERE s.transcript_id = se.transcript_id AND s.speaker_id = se.speaker_id AND s.person_id = :person"
        ),
        {"person": person_id},
    )
    samples = await conn.execute(delete(t.voice_samples).where(t.voice_samples.c.person_id == person_id))
    suggestions = await conn.execute(
        delete(t.speaker_suggestions).where(
            t.speaker_suggestions.c.person_id == person_id, t.speaker_suggestions.c.status == "pending"
        )
    )
    return samples.rowcount, suggestions.rowcount


async def forget_sample(conn: AsyncConnection, person_id: UUID, key: SpeakerKey) -> bool:
    """Remove a sample from the person's voiceprint, under the owner's RLS; the speaker stays linked."""
    vs = t.voice_samples.c
    result = await conn.execute(
        delete(t.voice_samples).where(
            vs.person_id == person_id, vs.transcript_id == key.transcript_id, vs.speaker_id == key.speaker_id
        )
    )
    return result.rowcount > 0
