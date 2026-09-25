"""Identificação por voz: amostras da impressão, comparação na ingestão, sugestões e auditoria.

Regras em docs/standards/code/identificacao-por-voz.md. A impressão de uma pessoa é o conjunto das
amostras dela (`voice_samples`), uma por locutor confirmado; comparar é o cosseno entre o embedding
do locutor novo e o centroide normalizado dessas amostras. Nada é comparado nem guardado como
amostra sem o opt-in da organização e o consentimento `granted` da pessoa.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from sqlalchemy import and_, func, insert, literal, select, text, update

from eclume_server.db import tables as t

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.auth import Principal

# Calibração em docs/project/calibracao-voz.md: limiar padrão, fala mínima para comparar um locutor
# e para ele virar amostra. Abaixo disso o embedding é ruído demais.
DEFAULT_THRESHOLD = 0.55
MIN_COMPARE_TALK_MS = 10_000
MIN_SAMPLE_TALK_MS = 10_000
MAX_SUGGESTIONS = 3
# Retranscrição: o locutor novo herda o vínculo do antigo quando a fala dos dois se sobrepõe ao
# menos nesta fração, nos dois sentidos.
RESTORE_OVERLAP = 0.5

DEFAULT_TERM_VERSION = "1"
DEFAULT_TERM_TEXT = (
    "Autorizo a organização a criar e guardar uma impressão da minha voz, calculada das gravações de "
    "reuniões de que participo, com a única finalidade de sugerir meu nome como locutor nas transcrições "
    "do eclume. Sei que a impressão de voz é dado pessoal sensível (biométrico, LGPD, art. 11), que "
    "nenhuma sugestão vira identificação sem a confirmação de uma pessoa, e que posso, a qualquer "
    "momento, revogar este consentimento, pedir a exclusão da impressão ou uma cópia dos meus dados."
)
VOICE_DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "suggestion_threshold": DEFAULT_THRESHOLD,
    "consent_term_version": DEFAULT_TERM_VERSION,
    "consent_term_text": DEFAULT_TERM_TEXT,
}


def voice_settings(block: dict[str, Any] | None) -> dict[str, Any]:
    """Bloco `voice_identification` com os padrões do termo para o que a organização não gravou."""
    return {**VOICE_DEFAULTS, **(block or {})}


async def org_voice(conn: AsyncConnection, org_id: UUID) -> dict[str, Any]:
    """Configuração de voz da organização (legível sob a RLS por qualquer membro)."""
    block = (
        await conn.execute(select(t.org_settings.c.voice_identification).where(t.org_settings.c.org_id == org_id))
    ).scalar()
    return voice_settings(block)


async def audit(  # noqa: PLR0913 — os campos do evento
    conn: AsyncConnection,
    org_id: UUID,
    event: str,
    *,
    person_id: UUID | None = None,
    actor_id: UUID | None = None,
    transcript_id: UUID | None = None,
    speaker_id: str | None = None,
    score: float | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    """Um evento na trilha; o nome da pessoa é copiado para sobreviver à exclusão dela."""
    name = select(t.people.c.name).where(t.people.c.id == person_id).scalar_subquery() if person_id else None
    await conn.execute(
        # Id gerado aqui: sem `RETURNING`, que exigiria ler a trilha (só admin lê).
        insert(t.voice_audit).values(
            id=uuid4(),
            org_id=org_id,
            person_id=person_id,
            person_name=name,
            actor_id=actor_id,
            event=event,
            transcript_id=transcript_id,
            speaker_id=speaker_id,
            score=score,
            details=details or {},
        )
    )


# --- amostras -----------------------------------------------------------------------------------

_ADD_SAMPLE = text(
    """
    INSERT INTO voice_samples (transcript_id, speaker_id, org_id, person_id, model, embedding, talk_ms, created_by)
    SELECT e.transcript_id, e.speaker_id, e.org_id, sp.person_id, e.model, e.embedding, sp.talk_ms, :actor
    FROM speaker_embeddings e
    JOIN speakers sp ON sp.transcript_id = e.transcript_id AND sp.speaker_id = e.speaker_id
    JOIN people p ON p.id = sp.person_id AND p.org_id = e.org_id
    JOIN org_settings o ON o.org_id = e.org_id
    WHERE e.transcript_id = :transcript AND e.speaker_id = :speaker
      AND p.voice_consent_status = 'granted'
      AND (o.voice_identification ->> 'enabled')::boolean
      AND sp.talk_ms >= :min_talk
    ON CONFLICT (transcript_id, speaker_id) DO NOTHING
    RETURNING person_id
    """
)


async def add_sample(conn: AsyncConnection, transcript_id: UUID, speaker_id: str, actor_id: UUID | None) -> bool:
    """Guarda o locutor (já ligado) como amostra da pessoa, se o opt-in e o consentimento deixam."""
    params = {"transcript": transcript_id, "speaker": speaker_id, "actor": actor_id, "min_talk": MIN_SAMPLE_TALK_MS}
    return (await conn.execute(_ADD_SAMPLE, params)).first() is not None


# --- ingestão: vínculos preservados e comparação -------------------------------------------------


@dataclass(frozen=True)
class OldLink:
    """Vínculo de um locutor antes da retranscrição, com a fala dele."""

    speaker_id: str
    person_id: UUID
    label: str
    spans: list[tuple[int, int]]


async def capture_links(conn: AsyncConnection, transcript_id: UUID) -> list[OldLink]:
    """Os locutores ligados da transcrição e os intervalos de fala de cada um (antes de apagar)."""
    sp, sg = t.speakers.c, t.segments.c
    linked = (
        await conn.execute(
            select(sp.speaker_id, sp.person_id, sp.label).where(
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
    return [OldLink(row.speaker_id, row.person_id, row.label, spans.get(row.speaker_id, [])) for row in linked]


def _merged(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    result: list[tuple[int, int]] = []
    for start, end in sorted(spans):
        if result and start <= result[-1][1]:
            result[-1] = (result[-1][0], max(result[-1][1], end))
        elif end > start:
            result.append((start, end))
    return result


def _overlap(a: list[tuple[int, int]], b: list[tuple[int, int]]) -> int:
    """Interseção total de duas listas de intervalos já mescladas e ordenadas."""
    total, i, j = 0, 0, 0
    while i < len(a) and j < len(b):
        total += max(0, min(a[i][1], b[j][1]) - max(a[i][0], b[j][0]))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return total


def match_links(old: list[OldLink], new_segments: list[dict[str, Any]]) -> tuple[dict[str, OldLink], list[OldLink]]:
    """Casa cada vínculo antigo com o locutor novo de maior sobreposição de fala, um para um.

    Só casa com sobreposição ≥ `RESTORE_OVERLAP` da fala dos dois. Devolve `({novo: antigo}, perdidos)`.
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
    conn: AsyncConnection, org_id: UUID, transcript_id: UUID, old: list[OldLink], new_segments: list[dict[str, Any]]
) -> None:
    """Reaplica aos locutores novos os vínculos confirmados antes da retranscrição (papel de sistema)."""
    matched, dropped = match_links(old, new_segments)
    for new_id, link in matched.items():
        await conn.execute(
            update(t.speakers)
            .where(t.speakers.c.transcript_id == transcript_id, t.speakers.c.speaker_id == new_id)
            .values(person_id=link.person_id, label=link.label)
        )
        sampled = await add_sample(conn, transcript_id, new_id, None)
        await audit(
            conn,
            org_id,
            "link_restored",
            person_id=link.person_id,
            transcript_id=transcript_id,
            speaker_id=new_id,
            details={"previous_speaker_id": link.speaker_id, "sample": sampled},
        )
    for link in dropped:
        await audit(
            conn,
            org_id,
            "link_dropped",
            person_id=link.person_id,
            transcript_id=transcript_id,
            speaker_id=link.speaker_id,
            details={"reason": "sem locutor novo com a mesma fala"},
        )


# Centroide normalizado das amostras de cada pessoa com consentimento, do mesmo modelo e dimensão;
# cosseno com cada locutor sem pessoa e com fala suficiente. Só a organização da transcrição.
_COMPARE = text(
    """
    WITH prints AS (
        SELECT s.person_id, l2_normalize(avg(l2_normalize(s.embedding))) AS centroid, count(*) AS samples
        FROM voice_samples s
        JOIN people p ON p.id = s.person_id
        WHERE s.org_id = :org AND p.voice_consent_status = 'granted'
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


async def suggest(conn: AsyncConnection, org_id: UUID, transcript_id: UUID, model: str, dims: int) -> int:
    """Compara os locutores da transcrição com as impressões e grava as sugestões acima do limiar.

    Roda na ingestão, com o papel de sistema: filtra a organização explicitamente. Devolve quantas
    sugestões gravou; a comparação fica na auditoria mesmo sem nenhuma.
    """
    settings = await org_voice(conn, org_id)
    if not settings["enabled"]:
        return 0
    threshold = float(settings["suggestion_threshold"])
    params = {
        "org": org_id,
        "transcript": transcript_id,
        "model": model,
        "dims": dims,
        "min_talk": MIN_COMPARE_TALK_MS,
    }
    rows = (await conn.execute(_COMPARE, params)).all()
    per_speaker: dict[str, int] = {}
    suggested = []
    for row in rows:
        if row.score >= threshold and per_speaker.get(row.speaker_id, 0) < MAX_SUGGESTIONS:
            per_speaker[row.speaker_id] = per_speaker.get(row.speaker_id, 0) + 1
            suggested.append(row)
    for row in suggested:
        await conn.execute(
            insert(t.speaker_suggestions).values(
                transcript_id=transcript_id,
                speaker_id=row.speaker_id,
                org_id=org_id,
                person_id=row.person_id,
                score=min(1.0, float(row.score)),
            )
        )
        await audit(
            conn,
            org_id,
            "suggested",
            person_id=row.person_id,
            transcript_id=transcript_id,
            speaker_id=row.speaker_id,
            score=min(1.0, float(row.score)),
            details={"threshold": threshold, "model": model, "samples": row.samples},
        )
    await audit(
        conn,
        org_id,
        "comparison",
        transcript_id=transcript_id,
        details={
            "model": model,
            "threshold": threshold,
            "people": len({row.person_id for row in rows}),
            "speakers": len({row.speaker_id for row in rows}),
            "suggestions": len(suggested),
        },
    )
    return len(suggested)


# --- leitura das sugestões ----------------------------------------------------------------------


async def load_suggestions(conn: AsyncConnection, transcript_ids: list[UUID]) -> dict[tuple[UUID, str], list[dict]]:
    """Sugestões pendentes de locutores sem pessoa, por `(transcrição, locutor)`, maior `score` antes.

    Com o opt-in da organização desligado, nenhuma aparece.
    """
    if not transcript_ids:
        return {}
    ss, sp, pe = t.speaker_suggestions.c, t.speakers.c, t.people.c
    enabled = (
        select(t.org_settings.c.voice_identification["enabled"].as_boolean())
        .where(t.org_settings.c.org_id == ss.org_id)
        .scalar_subquery()
    )
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
    """Um locutor de uma transcrição."""

    transcript_id: UUID
    speaker_id: str


async def on_link(
    conn: AsyncConnection, principal: Principal, key: SpeakerKey, old_person: UUID | None, new_person: UUID | None
) -> None:
    """Depois do `PATCH` que troca a pessoa do locutor: aceite da sugestão e a amostra nova.

    A amostra da pessoa anterior já saiu pelo gatilho `speakers_voice_relink`.
    """
    if new_person is None or new_person == old_person:
        return
    org_id, actor_id = principal.org_id, principal.user_id
    transcript_id, speaker_id = key.transcript_id, key.speaker_id
    ss = t.speaker_suggestions.c
    accepted = await conn.execute(
        update(t.speaker_suggestions)
        .where(
            ss.transcript_id == transcript_id,
            ss.speaker_id == speaker_id,
            ss.person_id == new_person,
            ss.status == "pending",
        )
        .values(status="accepted", decided_by=actor_id, decided_at=datetime.now(UTC))
        .returning(ss.score)
    )
    score = accepted.scalar()
    if score is not None:
        await audit(
            conn,
            org_id,
            "accepted",
            person_id=new_person,
            actor_id=actor_id,
            transcript_id=transcript_id,
            speaker_id=speaker_id,
            score=score,
        )
    if await add_sample(conn, transcript_id, speaker_id, actor_id):
        await audit(
            conn,
            org_id,
            "sample_added",
            person_id=new_person,
            actor_id=actor_id,
            transcript_id=transcript_id,
            speaker_id=speaker_id,
        )


async def reject(conn: AsyncConnection, principal: Principal, key: SpeakerKey, person_id: UUID) -> bool:
    """Marca a sugestão pendente como recusada; `False` se não havia."""
    org_id, actor_id = principal.org_id, principal.user_id
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
        .values(status="rejected", decided_by=actor_id, decided_at=datetime.now(UTC))
        .returning(ss.score)
    )
    score = result.scalar()
    if score is None:
        return False
    await audit(
        conn,
        org_id,
        "rejected",
        person_id=person_id,
        actor_id=actor_id,
        transcript_id=transcript_id,
        speaker_id=speaker_id,
        score=score,
    )
    return True


async def forget(conn: AsyncConnection, person_id: UUID | None) -> tuple[int, int]:
    """Apaga as amostras e as sugestões pendentes da pessoa (ou da organização, com `None`)."""
    row = (await conn.execute(text("SELECT * FROM eclume_voice_forget(:person)"), {"person": person_id})).one()
    return int(row.samples), int(row.suggestions)
