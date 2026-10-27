"""Markers: instants of a recording with an optional note, sent by the apps (desktop and phone).

Idempotent by `client_id`: the app resends after a network failure, and the same marker only
updates the note. Rules in docs/standards/code/server-nucleo.md.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import UUID

from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert

from eclume_server.db import tables as t
from eclume_server.pagination import iso

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

MAX_NOTE = 500
MAX_BATCH = 1000
# The `bigint` ceiling: above it, 422 instead of a database error.
MAX_AT_MS = 2**63 - 1


class MarkerInput(BaseModel):
    """Schema `MarkerInput`."""

    client_id: UUID
    at_ms: int = Field(ge=0, le=MAX_AT_MS)
    note: str | None = Field(default=None, max_length=MAX_NOTE)


def marker_json(row: Row) -> dict[str, Any]:
    """Schema `Marker`."""
    return {
        "id": str(row["id"]),
        "recording_id": str(row["recording_id"]),
        "client_id": str(row["client_id"]),
        "at_ms": row["at_ms"],
        "note": row["note"],
        "device_name": row["device_name"],
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
    }


async def upsert_markers(  # noqa: PLR0913 — the recording, the batch and who marked it
    conn: AsyncConnection,
    *,
    owner_id: UUID,
    recording_id: UUID,
    markers: list[dict[str, Any]],
    device_name: str | None,
    created_by: UUID,
) -> None:
    """Store the batch; an already known `client_id` only updates the note (the last of the batch wins)."""
    unique = {str(marker["client_id"]): marker for marker in markers}
    if not unique:
        return
    rows = [
        {
            "owner_id": owner_id,
            "recording_id": recording_id,
            "client_id": UUID(client_id),
            "at_ms": marker["at_ms"],
            "note": marker.get("note"),
            "device_name": device_name,
            "created_by": created_by,
        }
        for client_id, marker in unique.items()
    ]
    statement = insert(t.markers).values(rows)
    await conn.execute(
        statement.on_conflict_do_update(
            index_elements=["recording_id", "client_id"],
            # A resend without a note does not erase the note edited afterwards (on the web).
            set_={"note": func.coalesce(statement.excluded.note, t.markers.c.note), "updated_at": func.now()},
        )
    )
    await touch_recording(conn, recording_id)


async def touch_recording(conn: AsyncConnection, recording_id: UUID) -> None:
    """Bump the recording's `updated_at`: it is how the synced folder's `?since=` sees the new note."""
    await conn.execute(update(t.recordings).where(t.recordings.c.id == recording_id).values(updated_at=func.now()))


async def list_markers(conn: AsyncConnection, recording_id: UUID) -> list[Row]:
    """The recording's markers, in `at_ms` order."""
    m = t.markers.c
    query = select(t.markers).where(m.recording_id == recording_id).order_by(m.at_ms, m.id)
    return list((await conn.execute(query)).mappings().all())
