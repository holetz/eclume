"""The write operations on a recording, shared by MCP, the API and the Agent.

Each function runs inside the caller's transaction, under the owner's RLS (`user_tx`): another
account's recording is 404, as in the route. The caller checks the scope (MCP by the token, the
route by the dependency, the Agent on confirmation) and, after the commit, enqueues the returned
summary. The Agent calls these functions in its own process, instead of `/mcp` over HTTP
(holetz/eclume#145). Contract in docs/standards/code/server-agentes.md §Agente and
docs/standards/code/server-mcp-e-dispositivos.md.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import select, update

from eclume_server.agenda_types import apply_type
from eclume_server.db import tables as t
from eclume_server.fields import builtin_fields, set_value, validate_value
from eclume_server.pipeline import current_revision
from eclume_server.problems import invalid_field
from eclume_server.quotas import charge_agent, check_open_summaries
from eclume_server.recordings import get_visible
from eclume_server.summaries import (
    create_summary,
    recording_transcript,
    start_auto_summary,
    summary_agenda_type,
    summary_provider,
)

if TYPE_CHECKING:
    from uuid import UUID

    from arq.connections import ArqRedis
    from sqlalchemy.ext.asyncio import AsyncConnection


async def regenerate_summary(
    conn: AsyncConnection, redis: ArqRedis, owner_id: UUID, recording_id: UUID
) -> tuple[UUID, str]:
    """Open a new summary from the recording's agenda type instructions; return the id to enqueue and the quota token.

    The caller refunds the token (`refund_agent_request`) if the summary does not reach the queue.

    404 without the recording, 409 `transcript_missing` without a transcript, 429 with the open
    summaries at the ceiling and 403 `quota_exceeded` with the agent's 24 h quota exhausted (the
    request counts in it).
    """
    transcript = await recording_transcript(conn, recording_id)
    agenda_type = await summary_agenda_type(conn, transcript, None)
    provider = await summary_provider(conn, None)
    await check_open_summaries(conn, owner_id)
    row = await create_summary(
        conn,
        transcript=transcript,
        agenda_type=agenda_type,
        provider=provider,
        trigger="manual",
        created_by=owner_id,
    )
    token = await charge_agent(conn, redis, owner_id)
    return row["id"], token


async def _touch(conn: AsyncConnection, recording_id: UUID, now: datetime) -> None:
    # What shows in the transcript changed: `?since=` must see it.
    await conn.execute(update(t.transcripts).where(t.transcripts.c.recording_id == recording_id).values(updated_at=now))


async def edit_tags(
    conn: AsyncConnection, owner_id: UUID, recording_id: UUID, *, add: list[str], remove: list[str]
) -> bool:
    """Add and remove tags (origin `edited`, as on screen); `False` if nothing changed."""
    recording = await get_visible(conn, recording_id)
    current = list(recording["tags"] or [])
    removed = {tag.casefold() for tag in remove}
    kept = [tag for tag in current if tag.casefold() not in removed]
    present = {tag.casefold() for tag in kept}
    wanted = kept + [tag for tag in dict.fromkeys(add) if tag.strip() and tag.casefold() not in present]
    if wanted == current:
        return False
    builtins = await builtin_fields(conn, owner_id)
    await set_value(conn, recording_id, builtins["tags"], validate_value(builtins["tags"], wanted), "edited")
    now = datetime.now(UTC)
    await conn.execute(update(t.recordings).where(t.recordings.c.id == recording_id).values(updated_at=now))
    await _touch(conn, recording_id, now)
    return True


async def check_collections(conn: AsyncConnection, collection_ids: list[UUID]) -> None:
    """422 if some id is not a collection of the transaction's user."""
    wanted = set(collection_ids)
    if not wanted:
        return
    found = set((await conn.execute(select(t.collections.c.id).where(t.collections.c.id.in_(wanted)))).scalars())
    if wanted - found:
        raise invalid_field("collection_ids", "coleção inexistente")


async def edit_collections(conn: AsyncConnection, recording_id: UUID, *, add: list[UUID], remove: list[UUID]) -> bool:
    """Add the recording to and remove it from existing collections; the collections agent no longer changes them.

    422 if some collection of `add` is not the owner's; `False` if nothing changed.
    """
    await check_collections(conn, add)
    recording = await get_visible(conn, recording_id)
    current = list(recording["collection_ids"] or [])
    wanted = [cid for cid in current if cid not in set(remove)]
    wanted += [cid for cid in dict.fromkeys(add) if cid not in wanted]
    if wanted == current:
        return False
    now = datetime.now(UTC)
    await conn.execute(
        update(t.recordings)
        .where(t.recordings.c.id == recording_id)
        .values(collection_ids=wanted, collections_origin="edited", updated_at=now)
    )
    await _touch(conn, recording_id, now)
    return True


async def change_agenda_type(conn: AsyncConnection, recording_id: UUID, agenda_type_id: UUID | None) -> UUID | None:
    """The type the user chose: apply title and tags and, once transcribed, open the new automatic summary.

    `None` removes the type and hands the choice back to detection. Return the summary to enqueue, if any.
    """
    agenda_type = None
    if agenda_type_id is not None:
        agenda_type = (
            (await conn.execute(select(t.agenda_types).where(t.agenda_types.c.id == agenda_type_id))).mappings().first()
        )
        if agenda_type is None:
            raise invalid_field("agenda_type_id", "tipo de agenda inexistente ou sem acesso")
    current = (await conn.execute(select(t.recordings).where(t.recordings.c.id == recording_id))).mappings().one()
    await apply_type(conn, current, agenda_type, "edited" if agenda_type is not None else None)
    revision = await current_revision(conn, recording_id)
    if agenda_type is None or current["status"] != "transcribed" or revision is None:
        return None
    return await start_auto_summary(conn, recording_id, revision)


__all__ = ["change_agenda_type", "edit_collections", "edit_tags", "regenerate_summary"]
