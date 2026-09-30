"""Identificação por voz: amostras da impressão, comparação na ingestão e sugestões.

Regras em docs/standards/code/identificacao-por-voz.md. A impressão de uma pessoa é o conjunto das
amostras dela (`voice_samples`), uma por locutor confirmado; comparar é o cosseno entre o embedding
do locutor novo e o centroide normalizado dessas amostras, só entre pessoas do dono da transcrição.
Nada é comparado nem guardado como amostra com a identificação por voz desligada na plataforma; o
aceite do aviso no cadastro cobre o consentimento de quem o usuário grava.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import and_, delete, func, insert, literal, select, text, update

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
# Atribuição automática: limiar padrão da conta (calibracao-voz.md: FPR ~0,05% a 0,70), faixa aceita e a
# folga mínima entre a 1ª e a 2ª pessoa candidatas do mesmo locutor; sem folga, só sugere.
DEFAULT_AUTO_THRESHOLD = 0.75
MIN_AUTO_THRESHOLD = 0.5
MAX_AUTO_THRESHOLD = 0.99
AUTO_MARGIN = 0.05
# Retranscrição: o locutor novo herda o vínculo do antigo quando a fala dos dois se sobrepõe ao
# menos nesta fração, nos dois sentidos.
RESTORE_OVERLAP = 0.5

VOICE_DEFAULTS: dict[str, Any] = {"enabled": False, "suggestion_threshold": DEFAULT_THRESHOLD}


def voice_settings(block: dict[str, Any] | None) -> dict[str, Any]:
    """Bloco `voice_identification` (`enabled`, `suggestion_threshold`), com os padrões."""
    block = block or {}
    return {key: block.get(key, default) for key, default in VOICE_DEFAULTS.items()}


async def platform_voice(conn: AsyncConnection) -> dict[str, Any]:
    """Configuração de voz da plataforma (legível sob a RLS por qualquer usuário)."""
    return voice_settings((await conn.execute(select(t.platform_settings.c.voice_identification))).scalar())


# --- amostras -----------------------------------------------------------------------------------

_ADD_SAMPLE = text(
    """
    INSERT INTO voice_samples (transcript_id, speaker_id, owner_id, person_id, model, embedding, talk_ms, created_by)
    SELECT e.transcript_id, e.speaker_id, e.owner_id, sp.person_id, e.model, e.embedding, sp.talk_ms, :actor
    FROM speaker_embeddings e
    JOIN speakers sp ON sp.transcript_id = e.transcript_id AND sp.speaker_id = e.speaker_id
    CROSS JOIN platform_settings o
    WHERE e.transcript_id = :transcript AND e.speaker_id = :speaker
      AND sp.person_id IS NOT NULL AND sp.auto_score IS NULL
      AND (o.voice_identification ->> 'enabled')::boolean
      AND sp.talk_ms >= :min_talk
    ON CONFLICT (transcript_id, speaker_id) DO NOTHING
    RETURNING person_id
    """
)


async def add_sample(conn: AsyncConnection, transcript_id: UUID, speaker_id: str, actor_id: UUID | None) -> bool:
    """Guarda o locutor (ligado e confirmado) como amostra da pessoa, com a identificação por voz ligada.

    O vínculo que a voz fez sozinho (`auto_score`) não entra: só uma confirmação reforça a impressão.
    """
    params = {"transcript": transcript_id, "speaker": speaker_id, "actor": actor_id, "min_talk": MIN_SAMPLE_TALK_MS}
    return (await conn.execute(_ADD_SAMPLE, params)).first() is not None


# --- ingestão: vínculos preservados e comparação -------------------------------------------------


@dataclass(frozen=True)
class OldLink:
    """Vínculo de um locutor antes da retranscrição, com a fala dele."""

    speaker_id: str
    person_id: UUID
    label: str
    auto_score: float | None
    spans: list[tuple[int, int]]


async def capture_links(conn: AsyncConnection, transcript_id: UUID) -> list[OldLink]:
    """Os locutores ligados da transcrição e os intervalos de fala de cada um (antes de apagar)."""
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
    conn: AsyncConnection, transcript_id: UUID, old: list[OldLink], new_segments: list[dict[str, Any]]
) -> None:
    """Reaplica aos locutores novos os vínculos confirmados antes da retranscrição (papel de conexão)."""
    matched, _ = match_links(old, new_segments)
    for new_id, link in matched.items():
        await conn.execute(
            update(t.speakers)
            .where(t.speakers.c.transcript_id == transcript_id, t.speakers.c.speaker_id == new_id)
            .values(person_id=link.person_id, label=link.label, auto_score=link.auto_score)
        )
        await add_sample(conn, transcript_id, new_id, None)


# Centroide normalizado das amostras de cada pessoa, do mesmo modelo e dimensão; cosseno com cada
# locutor sem pessoa e com fala suficiente. Só as pessoas do dono da transcrição.
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
    """Preferência da conta: atribuir sozinho e a partir de que pontuação."""

    enabled: bool
    threshold: float


async def auto_prefs(conn: AsyncConnection, user_id: UUID) -> AutoPrefs:
    """Preferência de atribuição automática do usuário (o padrão, se a conta não existe mais)."""
    row = (
        await conn.execute(
            select(t.users.c.voice_auto_assign, t.users.c.voice_auto_threshold).where(t.users.c.id == user_id)
        )
    ).first()
    return (
        AutoPrefs(enabled=True, threshold=DEFAULT_AUTO_THRESHOLD) if row is None else AutoPrefs(row[0], float(row[1]))
    )


def pick_auto(rows: list[Any], threshold: float) -> dict[str, Any]:
    """Escolhe `{locutor: linha}` a atribuir: 1ª candidata ≥ limiar, com folga sobre a 2ª e sem repetir pessoa.

    `rows` vem ordenada por locutor e por pontuação decrescente. A folga (`AUTO_MARGIN`) evita ligar
    quando duas pessoas têm voz parecida com a do locutor; a pessoa que dois locutores disputam fica
    com o de maior pontuação.
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
    """Compara os locutores da transcrição com as impressões, liga os de alta confiança e sugere o resto.

    Roda na ingestão, com o papel de conexão: filtra o dono explicitamente. Com a atribuição
    automática ligada na conta, o locutor com pontuação ≥ o limiar dela é ligado à pessoa (e o
    rótulo vira o nome dela) antes de a cadeia de agentes e o resumo lerem a transcrição; os demais
    recebem sugestões acima do limiar da plataforma. Devolve quantas sugestões gravou.
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


# --- leitura das sugestões ----------------------------------------------------------------------


async def load_suggestions(conn: AsyncConnection, transcript_ids: list[UUID]) -> dict[tuple[UUID, str], list[dict]]:
    """Sugestões pendentes de locutores sem pessoa, por `(transcrição, locutor)`, maior `score` antes.

    Com a identificação por voz desligada na plataforma, nenhuma aparece.
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
    """Um locutor de uma transcrição."""

    transcript_id: UUID
    speaker_id: str


async def on_link(conn: AsyncConnection, principal: Principal, key: SpeakerKey, new_person: UUID | None) -> None:
    """Depois do `PATCH` que troca a pessoa do locutor: aceite da sugestão e a amostra nova.

    A amostra da pessoa anterior já saiu pelo gatilho `speakers_voice_relink`. Mandar a mesma
    pessoa confirma o vínculo que a voz fez sozinho: o `PATCH` já zerou o `auto_score`, e agora a
    amostra entra.
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
    """Marca a sugestão pendente como recusada; `False` se não havia."""
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


async def purge_embeddings(conn: AsyncConnection) -> tuple[int, int]:
    """Apaga os `speaker_embeddings` e as sugestões pendentes de toda a plataforma (papel de conexão)."""
    embeddings = await conn.execute(delete(t.speaker_embeddings))
    suggestions = await conn.execute(delete(t.speaker_suggestions).where(t.speaker_suggestions.c.status == "pending"))
    return embeddings.rowcount, suggestions.rowcount


async def forget(conn: AsyncConnection, person_id: UUID) -> tuple[int, int]:
    """Apaga as amostras e as sugestões pendentes da pessoa, sob a RLS do dono."""
    samples = await conn.execute(delete(t.voice_samples).where(t.voice_samples.c.person_id == person_id))
    suggestions = await conn.execute(
        delete(t.speaker_suggestions).where(
            t.speaker_suggestions.c.person_id == person_id, t.speaker_suggestions.c.status == "pending"
        )
    )
    return samples.rowcount, suggestions.rowcount


async def forget_sample(conn: AsyncConnection, person_id: UUID, key: SpeakerKey) -> bool:
    """Tira uma amostra da impressão da pessoa, sob a RLS do dono; o locutor segue ligado."""
    vs = t.voice_samples.c
    result = await conn.execute(
        delete(t.voice_samples).where(
            vs.person_id == person_id, vs.transcript_id == key.transcript_id, vs.speaker_id == key.speaker_id
        )
    )
    return result.rowcount > 0
