"""Agenda types: the user's (`agenda_types`) and the platform defaults (`default_agenda_types`).

The type says how to recognize the recording, which title and tags it gets and how to summarize it.
Every account has a fallback type (`is_fallback`), which cannot be removed and keeps the recording
when no other one fits. Contract and decisions in docs/standards/code/processamento-automatico.md.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Annotated, Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select, update

from eclume_server.agents.extraction import MAX_INSTRUCTIONS, MAX_TAG, MIN_CONFIDENCE, TypeSpec, detect_type
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.pipeline import GONE, STALE, current_revision, get_step, set_step
from eclume_server.problems import invalid_field, not_found
from eclume_server.summaries import AgentStep, call_agent_step, load_provider, provider_for, transcript_text

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy import Table
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

Tag = Annotated[str, Field(min_length=1, max_length=MAX_TAG)]
# Cannot be null in a PATCH (the others accept `null`, which clears).
REQUIRED = ("name", "summary_instructions", "identify", "default_tags", "position", "title_instructions")
# The subject rule when neither the type nor the fallback has one (the built-in title's factory rule).
DEFAULT_TITLE_RULE = (
    "Um título curto, de até 8 palavras, que diga do que a conversa tratou. Sem data nem nomes de pessoas."
)


class AgendaTypeDraft(BaseModel):
    """Schema `AgendaTypeDraft`: the content of a type, saved or as a draft."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    title_pattern: str | None = Field(default=None, max_length=300)
    title_instructions: str = Field(default="", max_length=MAX_INSTRUCTIONS)
    identify: str = Field(default="", max_length=MAX_INSTRUCTIONS)
    default_tags: list[Tag] = Field(default_factory=list, max_length=20)
    summary_instructions: str = Field(min_length=1, max_length=MAX_INSTRUCTIONS)


class AgendaTypeCreate(AgendaTypeDraft):
    """Schema `AgendaTypeCreate`: without `position`, the type goes to the end of the list."""

    position: int | None = Field(default=None, ge=0)


class AgendaTypePatch(BaseModel):
    """Schema `AgendaTypePatch`."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)
    title_pattern: str | None = Field(default=None, max_length=300)
    title_instructions: str | None = Field(default=None, max_length=MAX_INSTRUCTIONS)
    identify: str | None = Field(default=None, max_length=MAX_INSTRUCTIONS)
    default_tags: list[Tag] | None = Field(default=None, max_length=20)
    summary_instructions: str | None = Field(default=None, min_length=1, max_length=MAX_INSTRUCTIONS)
    position: int | None = Field(default=None, ge=0)


class DefaultAgendaTypeCreate(AgendaTypeCreate):
    """Schema `DefaultAgendaTypeCreate`."""

    include_for_new_users: bool = True


class DefaultAgendaTypePatch(AgendaTypePatch):
    """Schema `DefaultAgendaTypePatch`."""

    include_for_new_users: bool | None = None


def agenda_type_json(row: Row) -> dict[str, Any]:
    """Schema `AgendaType`."""
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "title_pattern": row["title_pattern"],
        "title_instructions": row["title_instructions"],
        "identify": row["identify"],
        "default_tags": list(row["default_tags"]),
        "summary_instructions": row["summary_instructions"],
        "position": row["position"],
        "fallback": bool(row.get("is_fallback", False)),
    }


def default_agenda_type_json(row: Row) -> dict[str, Any]:
    """Schema `DefaultAgendaType`: the `AgendaType` without `fallback`, with `include_for_new_users`."""
    body = agenda_type_json(row)
    del body["fallback"]
    return {**body, "include_for_new_users": row["include_for_new_users"]}


def create_values(body: AgendaTypeDraft) -> dict[str, Any]:
    """The values of a new type, with deduplicated tags (`position` resolved by the inserter)."""
    values = body.model_dump()
    values["default_tags"] = list(dict.fromkeys(values["default_tags"]))
    return values


def changes_of(body: AgendaTypePatch) -> dict[str, Any]:
    """The fields sent; refuses an empty body and `null` where the schema does not accept it."""
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise invalid_field("body", "send at least one field")
    for field in (*REQUIRED, "include_for_new_users"):
        if field in values and values[field] is None:
            raise invalid_field(field, "cannot be null")
    if "default_tags" in values:
        values["default_tags"] = list(dict.fromkeys(values["default_tags"]))
    return values


async def next_position(conn: AsyncConnection, table: Table) -> int:
    """One position after the last of the list (the user's, under RLS, or the platform's).

    Serves the lists ordered by the user: agenda types and fields.
    """
    last = (await conn.execute(select(func.max(table.c.position)))).scalar()
    return 1 if last is None else last + 1


async def get_agenda_type(conn: AsyncConnection, agenda_type_id: UUID) -> Row:
    """The transaction user's type (RLS only shows theirs), or 404."""
    row = (await conn.execute(select(t.agenda_types).where(t.agenda_types.c.id == agenda_type_id))).mappings().first()
    if row is None:
        raise not_found("Agenda type does not exist or is not accessible.")
    return row


# --- applying the type to the recording --------------------------------------------------------------

_MARKER = re.compile(r"\{([a-z0-9_]+)\}")
# Separators between the title parts: ` · `, ` - `, ` | ` and the dashes.
_SEPARATOR = re.compile(r"(\s+[·\-|\u2013\u2014]\s+)")


def render_title(pattern: str, values: dict[str, str]) -> str:
    """The pattern with the placeholders replaced; a part left empty goes away together with its separator."""
    pieces = _SEPARATOR.split(pattern)
    parts = [_MARKER.sub(lambda match: values.get(match.group(1), ""), part).strip() for part in pieces[::2]]
    separators = pieces[1::2]
    kept: list[str] = []
    for index, part in enumerate(parts):
        if not part:
            continue
        if kept:
            kept.append(separators[index - 1])
        kept.append(part)
    return "".join(kept)


async def title_values(conn: AsyncConnection, recording: Row, agenda_type: Row | dict[str, Any]) -> dict[str, str]:
    """The pattern's placeholders: `{assunto}` is the automatic title, and each field, its value.

    Without an automatic title, the subject is the one stored before the first pattern (`subject`), never
    the already rendered title: reapplying a pattern does not nest.
    """
    fv = t.field_values.c
    rows = (
        await conn.execute(
            select(t.fields.c.key, t.fields.c.builtin, fv.value)
            .join(t.field_values, fv.field_id == t.fields.c.id)
            .where(fv.recording_id == recording["id"])
        )
    ).all()
    values = {"data": recording["recorded_at"].strftime("%d/%m/%Y"), "tipo": agenda_type["name"]}
    subject = recording["subject"] or recording["title"]
    for key, builtin, value in rows:
        text = ", ".join(value) if isinstance(value, list) else (value or "")
        if builtin == "title":
            subject = text or subject
        elif builtin is None:
            values[key] = text
    values["assunto"] = subject
    return values


async def apply_type(
    conn: AsyncConnection,
    recording: Row,
    agenda_type: Row | None,
    origin: str | None,
    *,
    render: bool = True,
) -> None:
    """Writes the recording's type and applies its title pattern and its default tags.

    The title only changes if it was neither written nor accepted by the user; the default tags add to
    the automatic ones, and the user's stay as they are. Without a type, it only clears the type.
    `render=False` leaves the title for later (detection: the fields, which come next, bring the new subject).
    """
    changes: dict[str, Any] = {
        "agenda_type_id": agenda_type["id"] if agenda_type is not None else None,
        "agenda_type_origin": origin,
    }
    if agenda_type is not None:
        fv = t.field_values.c
        locked = set(
            (
                await conn.execute(
                    select(t.fields.c.builtin)
                    .join(t.field_values, fv.field_id == t.fields.c.id)
                    .where(fv.recording_id == recording["id"], fv.origin.in_(("edited", "accepted")))
                )
            ).scalars()
        )
        if render and agenda_type["title_pattern"] and "title" not in locked:
            title = render_title(agenda_type["title_pattern"], await title_values(conn, recording, agenda_type))
            if title:
                changes["title"] = title
                if recording["subject"] is None:
                    changes["subject"] = recording["title"]
        if agenda_type["default_tags"] and "tags" not in locked:
            changes["tags"] = list(dict.fromkeys([*recording["tags"], *agenda_type["default_tags"]]))
    now = func.now()
    await conn.execute(
        update(t.recordings).where(t.recordings.c.id == recording["id"]).values(**changes, updated_at=now)
    )
    await conn.execute(
        update(t.transcripts).where(t.transcripts.c.recording_id == recording["id"]).values(updated_at=now)
    )


async def fallback_type(conn: AsyncConnection, owner_id: UUID) -> Row | None:
    """The account's fallback type (migration 021 and the seeding guarantee one)."""
    query = select(t.agenda_types).where(t.agenda_types.c.owner_id == owner_id, t.agenda_types.c.is_fallback)
    return (await conn.execute(query)).mappings().first()


async def title_rule(conn: AsyncConnection, recording: Row) -> str:
    """The title's subject rule: the recording type's, the fallback type's or the factory one."""
    rules = (
        await conn.execute(
            select(t.agenda_types.c.id, t.agenda_types.c.is_fallback, t.agenda_types.c.title_instructions).where(
                t.agenda_types.c.owner_id == recording["owner_id"],
                (t.agenda_types.c.id == recording["agenda_type_id"]) | t.agenda_types.c.is_fallback,
            )
        )
    ).all()
    own = next((rule for id_, _, rule in rules if id_ == recording["agenda_type_id"]), "")
    reserve = next((rule for _, fallback, rule in rules if fallback), "")
    return own.strip() or reserve.strip() or DEFAULT_TITLE_RULE


async def ensure_type(conn: AsyncConnection, recording_id: UUID) -> None:
    """Without a type after detection (skipped, failed), the recording keeps the fallback type."""
    recording = (await conn.execute(select(t.recordings).where(t.recordings.c.id == recording_id))).mappings().first()
    if recording is None or recording["agenda_type_id"] is not None:
        return
    reserve = await fallback_type(conn, recording["owner_id"])
    if reserve is not None:
        await apply_type(conn, recording, reserve, "auto", render=False)


async def refresh_title(conn: AsyncConnection, recording_id: UUID) -> None:
    """Rebuilds the title from the type's pattern and adds the default tags, after the fields are filled."""
    recording = (await conn.execute(select(t.recordings).where(t.recordings.c.id == recording_id))).mappings().first()
    if recording is None or recording["agenda_type_id"] is None:
        return
    agenda_type = (
        (await conn.execute(select(t.agenda_types).where(t.agenda_types.c.id == recording["agenda_type_id"])))
        .mappings()
        .first()
    )
    if agenda_type is not None:
        await apply_type(conn, recording, agenda_type, recording["agenda_type_origin"])


# --- detection (`detect_agenda_type` job) --------------------------------------------------------


async def run_detect(ctx: dict[str, Any], recording_id: UUID, revision: int) -> str:
    """The `detect_agenda_type` job: picks the recording's type and applies it; writes the `agenda_type` step.

    Runs with the connection role, in the CPU worker. The type chosen by the user (`edited`) stays. The
    fallback type does not compete: it keeps the recording when no other one fits or the confidence falls
    below `MIN_CONFIDENCE`; skipped or failed, the worker applies it later (`ensure_type`). The title waits
    for the fields, which come next.
    """
    engine = ctx["engine"]
    async with system_tx(engine) as conn:
        recording = (
            (await conn.execute(select(t.recordings).where(t.recordings.c.id == recording_id))).mappings().first()
        )
        if recording is None:
            return GONE
        if await current_revision(conn, recording_id) != revision:
            return STALE
        skip = None
        rows = (
            (
                await conn.execute(
                    select(t.agenda_types)
                    .where(t.agenda_types.c.owner_id == recording["owner_id"])
                    .order_by(t.agenda_types.c.position, t.agenda_types.c.id)
                )
            )
            .mappings()
            .all()
        )
        types = [row for row in rows if not row["is_fallback"]]
        reserve = next((row for row in rows if row["is_fallback"]), None)
        provider = await provider_for(conn, "agenda_detection")
        if recording["agenda_type_origin"] == "edited" and recording["agenda_type_id"] is not None:
            skip = "set_by_user"
        elif not types:
            skip = "no_types"
        elif provider is None:
            skip = "no_provider"
        if skip is not None:
            await set_step(conn, recording, revision, "agenda_type", "skipped", detail={"reason": skip})
            return f"pulada: {skip}"
        step = await get_step(conn, recording_id, revision, "agenda_type")
        started = step["started_at"] if step is not None else None
        detail = dict(step["detail"]) if step is not None else {}
        loaded = await load_provider(conn, provider["id"])
        transcript_id = (
            await conn.execute(select(t.transcripts.c.id).where(t.transcripts.c.recording_id == recording_id))
        ).scalar_one()
        transcript = await transcript_text(conn, transcript_id)
        await set_step(conn, recording, revision, "agenda_type", "active", detail=detail, started_at=started)
    specs = [TypeSpec(name=row["name"], identify=row["identify"]) for row in types]
    outcome = await call_agent_step(
        ctx,
        AgentStep(recording, revision, "agenda_type", started, detail),
        loaded,
        lambda agent: detect_type(agent, specs, transcript),
    )
    if isinstance(outcome, str):
        return outcome
    candidate = types[outcome.index] if outcome.index is not None else None
    unsure = outcome.confidence is not None and outcome.confidence < MIN_CONFIDENCE
    chosen = reserve if (candidate is None or unsure) and reserve is not None else candidate
    async with system_tx(engine) as conn:
        current = (await conn.execute(select(t.recordings).where(t.recordings.c.id == recording_id))).mappings().one()
        # The user may have chosen a type while the agent was working: that one stays.
        if current["agenda_type_origin"] != "edited" and chosen is not None:
            await apply_type(conn, current, chosen, "auto", render=False)
        await set_step(
            conn,
            recording,
            revision,
            "agenda_type",
            "done",
            detail={
                "agenda_type_id": str(chosen["id"]) if chosen is not None else None,
                "agenda_type_name": chosen["name"] if chosen is not None else None,
                "fallback": chosen is not None and chosen is reserve,
                "candidate_name": candidate["name"] if candidate is not None else None,
                "confidence": outcome.confidence,
                "reason_text": outcome.reason,
                "model": outcome.completion.model,
            },
        )
    return f"tipo: {chosen['name'] if chosen is not None else 'nenhum'}"
