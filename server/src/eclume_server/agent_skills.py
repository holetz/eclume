"""The Agent's skills: the person's reusable instructions, under the owner's RLS.

A skill has a short name (the conversation's `/name`), the description the agent reads to choose,
the instructions in Markdown and, optionally, the allowed tools (null = all).
Up to `MAX_SKILLS` per account. Contract in docs/standards/code/server-agentes.md §Agente.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.exc import IntegrityError

from eclume_server.agents.agent import MAX_LISTED_SKILLS
from eclume_server.agents.agent_tools import Skill, default_registry, skill_name
from eclume_server.db import tables as t
from eclume_server.pagination import iso
from eclume_server.problems import conflict, invalid_field, not_found

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

MAX_SKILLS = 50
MAX_NAME = 40
MAX_DESCRIPTION = 300
MAX_INSTRUCTIONS = 8000
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{1,39}$")
SKILL_TAKEN = "A skill with this name already exists."
# `/name` at the start of the message picks the skill; the rest is the question.
_PREFIX = re.compile(r"^/([a-z0-9][a-z0-9-]{1,39})(?:\s+|$)", re.IGNORECASE)

K = t.agent_skills.c


def skill_json(row: Row) -> dict[str, Any]:
    """Schema `AgentSkill`."""
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "description": row["description"],
        "instructions": row["instructions"],
        "allowed_tools": list(row["allowed_tools"]) if row["allowed_tools"] is not None else None,
        "enabled": row["enabled"],
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
    }


def check_name(value: str) -> str:
    """The normalized name (no slash, lowercase) or 422."""
    name = skill_name(value) or ""
    if not NAME.match(name):
        raise invalid_field("name", "2 to 40 lowercase letters, digits and hyphens, starting with a letter or digit")
    return name


def check_tools(value: list[str] | None) -> list[str] | None:
    """The allowed tools, deduplicated, all from the catalog; or 422."""
    if value is None:
        return None
    known = {item["name"] for item in default_registry().catalog()}
    wanted = list(dict.fromkeys(item.strip() for item in value))
    unknown = [item for item in wanted if item not in known]
    if unknown:
        raise invalid_field("allowed_tools", f"unknown tool: {', '.join(unknown)}")
    return wanted


def _text(field: str, value: str, limit: int) -> str:
    text = value.strip()
    if not text:
        raise invalid_field(field, "cannot be empty")
    if len(text) > limit:
        raise invalid_field(field, f"up to {limit} characters")
    return text


async def _get(conn: AsyncConnection, skill_id: UUID) -> Row:
    row = (await conn.execute(select(t.agent_skills).where(K.id == skill_id))).mappings().first()
    if row is None:
        raise not_found("Skill does not exist or is not accessible.")
    return row


async def list_skills(conn: AsyncConnection) -> dict[str, Any]:
    """The account's skills, by name."""
    rows = (await conn.execute(select(t.agent_skills).order_by(K.name))).mappings().all()
    return {"items": [skill_json(row) for row in rows]}


async def get_skill(conn: AsyncConnection, skill_id: UUID) -> dict[str, Any]:
    """A skill of the account, or 404."""
    return skill_json(await _get(conn, skill_id))


async def create_skill(conn: AsyncConnection, owner_id: UUID, values: dict[str, Any]) -> dict[str, Any]:
    """Registers the skill; a repeated name 409, above `MAX_SKILLS` 422."""
    count = (await conn.execute(select(func.count()).select_from(t.agent_skills))).scalar_one()
    if count >= MAX_SKILLS:
        raise invalid_field("name", f"up to {MAX_SKILLS} skills per account")
    row = {
        "owner_id": owner_id,
        "name": check_name(values["name"]),
        "description": _text("description", values["description"], MAX_DESCRIPTION),
        "instructions": _text("instructions", values["instructions"], MAX_INSTRUCTIONS),
        "allowed_tools": check_tools(values.get("allowed_tools")),
        "enabled": values.get("enabled", True),
    }
    try:
        async with conn.begin_nested():
            stmt = insert(t.agent_skills).values(**row).returning(t.agent_skills)
            created = (await conn.execute(stmt)).mappings().one()
    except IntegrityError as exc:
        raise conflict(SKILL_TAKEN, "skill_exists") from exc
    return skill_json(created)


async def update_skill(conn: AsyncConnection, skill_id: UUID, values: dict[str, Any]) -> dict[str, Any]:
    """Edits the fields sent; `allowed_tools: null` allows every tool."""
    await _get(conn, skill_id)
    changes: dict[str, Any] = {}
    if "name" in values:
        changes["name"] = check_name(values["name"])
    if "description" in values:
        changes["description"] = _text("description", values["description"], MAX_DESCRIPTION)
    if "instructions" in values:
        changes["instructions"] = _text("instructions", values["instructions"], MAX_INSTRUCTIONS)
    if "allowed_tools" in values:
        changes["allowed_tools"] = check_tools(values["allowed_tools"])
    if "enabled" in values:
        changes["enabled"] = bool(values["enabled"])
    if not changes:
        raise invalid_field("body", "send at least one field")
    try:
        async with conn.begin_nested():
            row = (
                (
                    await conn.execute(
                        update(t.agent_skills)
                        .where(K.id == skill_id)
                        .values(**changes, updated_at=func.now())
                        .returning(t.agent_skills)
                    )
                )
                .mappings()
                .one()
            )
    except IntegrityError as exc:
        raise conflict(SKILL_TAKEN, "skill_exists") from exc
    return skill_json(row)


async def delete_skill(conn: AsyncConnection, skill_id: UUID) -> None:
    """Deletes the skill; the messages that used it keep the name."""
    await _get(conn, skill_id)
    await conn.execute(delete(t.agent_skills).where(K.id == skill_id))


def split_prefix(message: str) -> tuple[str | None, str]:
    """`/name rest` → `("name", "rest")`; without a prefix, `(None, message)`."""
    found = _PREFIX.match(message.strip())
    if found is None:
        return None, message
    return found.group(1).lower(), message.strip()[found.end() :]


def as_skill(row: Row) -> Skill:
    """The skill in the agent protocol's format."""
    tools = tuple(row["allowed_tools"]) if row["allowed_tools"] is not None else None
    return Skill(row["name"], row["description"], row["instructions"], tools)


async def enabled_skill(conn: AsyncConnection, name: str) -> Row | None:
    """The enabled skill with that name, or `None`."""
    stmt = select(t.agent_skills).where(K.name == name, K.enabled.is_(True))
    return (await conn.execute(stmt)).mappings().first()


async def skill_briefs(conn: AsyncConnection) -> list[tuple[str, str]]:
    """`(name, description)` of the enabled skills, the ones the `system` lists."""
    stmt = select(K.name, K.description).where(K.enabled.is_(True)).order_by(K.name).limit(MAX_LISTED_SKILLS)
    return [(row.name, row.description) for row in (await conn.execute(stmt)).all()]


__all__ = [
    "MAX_SKILLS",
    "as_skill",
    "create_skill",
    "delete_skill",
    "enabled_skill",
    "get_skill",
    "list_skills",
    "skill_briefs",
    "split_prefix",
    "update_skill",
]
