"""The user's people directory: query with statistics, JSON shape, attributes and facets."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import Text, and_, distinct, exists, func, select, true

from eclume_server.db import tables as t
from eclume_server.pagination import iso
from eclume_server.problems import not_found

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy import ColumnElement, Select
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

# Under RLS, the subquery only sees the user's transcripts.
_stats = (
    select(
        func.count(distinct(t.speakers.c.transcript_id)).label("transcript_count"),
        func.max(t.recordings.c.recorded_at).label("last_seen_at"),
        func.coalesce(func.sum(t.speakers.c.talk_ms), 0).label("speaking_time_ms"),
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
    select(func.count().label("voice_sample_count"))
    .where(t.voice_samples.c.person_id == t.people.c.id)
    .lateral("samples")
)


def person_select() -> Select:
    """The user's people with the transcript statistics and the total of voice samples."""
    return select(
        t.people,
        _stats.c.transcript_count,
        _stats.c.last_seen_at,
        _stats.c.speaking_time_ms,
        _samples.c.voice_sample_count,
    ).select_from(t.people.join(_stats, true()).join(_samples, true()))


def person_json(row: Row) -> dict[str, Any]:
    """Schema `Person`."""
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "email": row["email"],
        "notes": row["notes"],
        "company": row["company"],
        "department": row["department"],
        "job_title": row["job_title"],
        "phone": row["phone"],
        "tags": list(row["tags"]),
        "transcript_count": row["transcript_count"],
        "last_seen_at": iso(row["last_seen_at"]),
        "voice_sample_count": row["voice_sample_count"],
        "speaking_time_ms": int(row["speaking_time_ms"]),
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
    }


async def get_person(conn: AsyncConnection, person_id: UUID) -> Any:  # noqa: ANN401
    """The user's person, or 404."""
    row = (await conn.execute(person_select().where(t.people.c.id == person_id))).mappings().first()
    if row is None:
        raise not_found("Person does not exist or is not accessible.")
    return row


def normalized(value: str) -> ColumnElement[str]:
    """`lower(unaccent(value))` in the database, like the `people.sort_name` column."""
    return func.lower(func.eclume_unaccent(value, type_=Text))


def prefix_filter(q: str) -> ColumnElement[bool]:
    """Name (any word) or e-mail starting with `q`, ignoring accents and case."""
    escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    term = normalized(escaped)
    sort_name = t.people.c.sort_name
    return (
        sort_name.like(term + "%", escape="\\")
        | sort_name.like("% " + term + "%", escape="\\")
        | normalized(func.coalesce(t.people.c.email, "")).like(term + "%", escape="\\")
    )


# --- profile attributes (020_pessoas_enriquecidas) ----------------------------------------------------

# The person's text attributes and the ceiling of each.
ATTRIBUTES = {"company": 120, "department": 120, "job_title": 120, "phone": 40}
MAX_PERSON_TAGS = 20
MAX_PERSON_TAG = 64


def clean_attribute(value: str | None) -> str | None:
    """The attribute without surrounding spaces; empty becomes `None`."""
    if value is None:
        return None
    return value.strip() or None


def clean_tags(tags: list[str]) -> list[str]:
    """Person tags without surrounding spaces, without empty ones and without repeats (ignoring case)."""
    seen: dict[str, str] = {}
    for tag in tags:
        name = tag.strip()
        if name and name.lower() not in seen:
            seen[name.lower()] = name
    return list(seen.values())


def _matches(column: ColumnElement[str], values: list[str]) -> ColumnElement[bool]:
    """The attribute equal to one of the values, ignoring accents and case."""
    return normalized(column).in_([normalized(value) for value in values])


def attribute_conditions(
    company: list[str] | None, department: list[str] | None, tag: list[str] | None
) -> list[ColumnElement[bool]]:
    """The conditions on `people` for each requested attribute: OR within an attribute, AND between them."""
    p = t.people.c
    conditions = []
    if company:
        conditions.append(_matches(p.company, company))
    if department:
        conditions.append(_matches(p.department, department))
    if tag:
        lowered = [value.lower() for value in tag]
        items = func.unnest(p.tags).table_valued("item").render_derived()
        conditions.append(exists(select(1).select_from(items).where(func.lower(items.c.item).in_(lowered))))
    return conditions


def participant_filter(conditions: list[ColumnElement[bool]]) -> ColumnElement[bool]:
    """Some speaker of the recording is linked to ONE person that meets every condition."""
    return exists(
        select(1)
        .select_from(
            t.speakers.join(t.transcripts, t.transcripts.c.id == t.speakers.c.transcript_id).join(
                t.people, t.people.c.id == t.speakers.c.person_id
            )
        )
        .where(t.transcripts.c.recording_id == t.recordings.c.id, and_(*conditions))
    )


async def facets(conn: AsyncConnection) -> dict[str, list[dict[str, Any]]]:
    """The values in use for company, area and person tag, with how many people use each.

    Company and area are grouped ignoring accents and case; the value shown is the most used spelling.
    """
    p = t.people.c
    result: dict[str, list[dict[str, Any]]] = {}
    for key, column in (("companies", p.company), ("departments", p.department)):
        grouped = normalized(column)
        rows = await conn.execute(
            select(func.mode().within_group(column).label("value"), func.count().label("count"))
            .where(column.is_not(None))
            .group_by(grouped)
            .order_by(func.min(grouped))
        )
        result[key] = [{"value": row.value, "count": row.count} for row in rows]
    items = func.unnest(p.tags).table_valued("item").render_derived()
    item = items.c.item
    lowered = func.lower(item)
    rows = await conn.execute(
        select(func.mode().within_group(item).label("value"), func.count(distinct(p.id)).label("count"))
        .select_from(t.people.join(items, true()))
        .group_by(lowered)
        .order_by(lowered)
    )
    result["tags"] = [{"value": row.value, "count": row.count} for row in rows]
    return result
