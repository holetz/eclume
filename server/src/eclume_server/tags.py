"""The user's tag registry: the fixed list the agent chooses from and what keeps it in order.

`recordings.tags` is still the recordings' value (search, the library and export read it); the
registry sits beside it. Every tag the user writes enters the registry in their spelling (`adopt`),
and renaming, merging and deleting change the recordings and the types' default tags. The agent
matches variations (`canonical`) before proposing a new tag. Contract in
docs/standards/code/processamento-automatico.md.
"""

from __future__ import annotations

import re
import unicodedata
from typing import TYPE_CHECKING, Literal

from sqlalchemy import func, select, text

from eclume_server.db import tables as t

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

Mode = Literal["fixed", "auto"]
# The registry ceiling for the agent: above it, the self-managed mode creates no more tags.
MAX_CATALOG = 200
MAX_NEW_LIMIT = 5

# Portuguese plural endings, replaced by the singular one before comparing.
_PLURALS = (("oes", "ao"), ("aes", "ao"), ("ais", "al"), ("eis", "el"), ("ns", "m"))
# Short words ending in "s" ("gas", "mes") are not treated as plural.
_MIN_PLURAL = 3


def _plain(name: str) -> str:
    """Lowercase and without accents, like the registry's unique index."""
    return unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower().strip()


def _singular(word: str) -> str:
    for plural, single in _PLURALS:
        if word.endswith(plural) and len(word) > len(plural) + 1:
            return word[: -len(plural)] + single
    return word[:-1] if word.endswith("s") and len(word) > _MIN_PLURAL else word


def canonical(name: str) -> str:
    """The form to compare two tags by: no accents or case, hyphens and spaces unified, in the singular."""
    return " ".join(_singular(word) for word in re.split(r"[\s_\-]+", _plain(name)) if word)


async def catalog(conn: AsyncConnection, owner_id: UUID) -> list[Row]:
    """The account's registered tags, in alphabetical order."""
    c = t.tags.c
    query = select(t.tags).where(c.owner_id == owner_id).order_by(func.lower(c.name), c.id)
    return list((await conn.execute(query)).mappings().all())


async def adopt(conn: AsyncConnection, owner_id: UUID, names: list[str], origin: str = "user") -> list[str]:
    """The tags in the registry's spelling, registering the missing ones; without repeats, in the given order.

    Compares ignoring accents and case, like the unique index: "Cliente" becomes the already registered "cliente".
    """
    known = {_plain(row["name"]): row["name"] for row in await catalog(conn, owner_id)}
    result: list[str] = []
    missing: list[str] = []
    for name in names:
        clean = name.strip()
        key = _plain(clean)
        if not clean:
            continue
        if key not in known:
            known[key] = clean
            missing.append(clean)
        result.append(known[key])
    if missing:
        await conn.execute(
            text(
                "INSERT INTO tags (owner_id, name, origin) "
                "SELECT :owner, n, :origin FROM unnest(CAST(:names AS text[])) AS n ON CONFLICT DO NOTHING"
            ),
            {"owner": owner_id, "origin": origin, "names": missing},
        )
    return list(dict.fromkeys(result))


def resolve(proposed: list[str] | None, names: list[str], *, allow_new: int, room: int) -> tuple[list[str], list[str]]:
    """The tags the agent proposed, matched against the registry: the ones that stay and, among them, the new ones.

    A variation of a registered tag (case, accent, plural) becomes the registered one. The others only
    stay in the self-managed mode (`allow_new`, the per-recording limit) and while the registry has
    room (`room`); in the fixed mode, they are dropped.
    """
    by_canonical: dict[str, str] = {}
    for name in names:
        by_canonical.setdefault(canonical(name), name)
    kept: list[str] = []
    new: list[str] = []
    for item in proposed or []:
        key = canonical(item)
        if not key:
            continue
        if key in by_canonical:
            kept.append(by_canonical[key])
        elif len(new) < min(allow_new, room):
            by_canonical[key] = item.strip()
            new.append(item.strip())
            kept.append(item.strip())
    return list(dict.fromkeys(kept)), new


async def prefs(conn: AsyncConnection, owner_id: UUID) -> tuple[Mode, int]:
    """The account's tag mode and the limit of new tags per recording (0 in the fixed mode)."""
    mode, limit = (
        await conn.execute(select(t.users.c.tag_mode, t.users.c.tag_new_limit).where(t.users.c.id == owner_id))
    ).one()
    return mode, limit if mode == "auto" else 0


# Replaces `:old` with `:new` (or removes it, with a null `:new`) in the recordings, keeping the order and without repeats.
_REPLACE_IN_RECORDINGS = text(
    """
    UPDATE recordings SET
        tags = coalesce(
            (
                SELECT array_agg(x.tag ORDER BY x.pos)
                FROM (
                    SELECT CASE WHEN u.tag = :old THEN CAST(:new AS text) ELSE u.tag END AS tag, min(u.i) AS pos
                    FROM unnest(recordings.tags) WITH ORDINALITY AS u(tag, i)
                    GROUP BY 1
                ) x
                WHERE x.tag IS NOT NULL
            ),
            '{}'
        ),
        updated_at = now()
    WHERE :old = ANY(tags)
    RETURNING id
    """
)
_REPLACE_IN_TYPES = text(
    """
    UPDATE agenda_types SET
        default_tags = coalesce(
            (
                SELECT array_agg(x.tag ORDER BY x.pos)
                FROM (
                    SELECT CASE WHEN u.tag = :old THEN CAST(:new AS text) ELSE u.tag END AS tag, min(u.i) AS pos
                    FROM unnest(agenda_types.default_tags) WITH ORDINALITY AS u(tag, i)
                    GROUP BY 1
                ) x
                WHERE x.tag IS NOT NULL
            ),
            '{}'
        ),
        updated_at = now()
    WHERE :old = ANY(default_tags)
    """
)


async def replace_everywhere(conn: AsyncConnection, old: str, new: str | None) -> int:
    """Replace the tag `old` with `new` (or remove it) in the recordings and in the account's types' default tags.

    Runs under the owner's RLS. The transcripts of the touched recordings bump their `updated_at`:
    title and tags show in them, and the clients' `?since=` must see the change. Return how many
    recordings changed.
    """
    moved = list((await conn.execute(_REPLACE_IN_RECORDINGS, {"old": old, "new": new})).scalars())
    await conn.execute(_REPLACE_IN_TYPES, {"old": old, "new": new})
    if moved:
        await conn.execute(
            t.transcripts.update().where(t.transcripts.c.recording_id.in_(moved)).values(updated_at=func.now())
        )
    return len(moved)
