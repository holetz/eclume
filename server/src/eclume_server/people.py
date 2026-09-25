"""Diretório de pessoas da organização: consulta com estatísticas e forma JSON."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import Text, distinct, func, select, true

from eclume_server.db import tables as t
from eclume_server.pagination import iso
from eclume_server.problems import not_found
from eclume_server.serialize import user_ref

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy import ColumnElement, Select
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

# Sob a RLS, a subconsulta só enxerga transcrições visíveis a quem pergunta.
_stats = (
    select(
        func.count(distinct(t.speakers.c.transcript_id)).label("transcript_count"),
        func.max(t.recordings.c.recorded_at).label("last_seen_at"),
    )
    .select_from(
        t.speakers.join(t.transcripts, t.transcripts.c.id == t.speakers.c.transcript_id).join(
            t.recordings, t.recordings.c.id == t.transcripts.c.recording_id
        )
    )
    .where(t.speakers.c.person_id == t.people.c.id)
    .lateral("stats")
)


_samples = (
    select(func.count().label("sample_count"))
    .select_from(t.voice_samples)
    .where(t.voice_samples.c.person_id == t.people.c.id)
    .lateral("samples")
)
_consent_by = t.users.alias("consent_by")


def person_select() -> Select:
    """Pessoas visíveis (da organização) com estatísticas, amostras de voz e quem registrou o consentimento."""
    return select(
        t.people,
        _stats.c.transcript_count,
        _stats.c.last_seen_at,
        _samples.c.sample_count,
        _consent_by.c.name.label("voice_consent_by_name"),
    ).select_from(
        t.people.join(_stats, true())
        .join(_samples, true())
        .outerjoin(_consent_by, _consent_by.c.id == t.people.c.voice_consent_by)
    )


def consent_json(row: Row) -> dict[str, Any]:
    """Schema `VoiceConsent`, de uma linha de `person_select`."""
    by = row["voice_consent_by"]
    return {
        "status": row["voice_consent_status"],
        "updated_at": iso(row["voice_consent_updated_at"]),
        "term_version": row["voice_consent_term_version"],
        "recorded_by": user_ref(by, row["voice_consent_by_name"]) if by and row["voice_consent_by_name"] else None,
        "sample_count": row["sample_count"],
    }


def person_json(row: Row) -> dict[str, Any]:
    """Schema `Person`."""
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "email": row["email"],
        "notes": row["notes"],
        "voice_consent": consent_json(row),
        "transcript_count": row["transcript_count"],
        "last_seen_at": iso(row["last_seen_at"]),
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
    }


async def get_person(conn: AsyncConnection, person_id: UUID) -> Any:  # noqa: ANN401
    """Pessoa visível, ou 404."""
    row = (await conn.execute(person_select().where(t.people.c.id == person_id))).mappings().first()
    if row is None:
        raise not_found("Pessoa inexistente ou sem acesso.")
    return row


def normalized(value: str) -> ColumnElement[str]:
    """`lower(unaccent(value))` no banco, como a coluna `people.sort_name`."""
    return func.lower(func.eclume_unaccent(value, type_=Text))


def prefix_filter(q: str) -> ColumnElement[bool]:
    """Nome (qualquer palavra) ou e-mail começando por `q`, sem acento nem caixa."""
    escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    term = normalized(escaped)
    sort_name = t.people.c.sort_name
    return (
        sort_name.like(term + "%", escape="\\")
        | sort_name.like("% " + term + "%", escape="\\")
        | normalized(func.coalesce(t.people.c.email, "")).like(term + "%", escape="\\")
    )
