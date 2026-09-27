"""Marcadores: instantes da gravação com nota opcional, vindos dos apps (desktop e celular).

Idempotentes por `client_id`: o app reenvia depois de uma falha de rede, e o mesmo marcador só
atualiza a nota. Regras em docs/standards/code/server-nucleo.md.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import UUID

from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from eclume_server.db import tables as t
from eclume_server.pagination import iso

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

MAX_NOTE = 500
MAX_BATCH = 1000
# O teto do `bigint`: acima dele, 422 em vez de erro do banco.
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


async def upsert_markers(  # noqa: PLR0913 — a gravação, o lote e quem marcou
    conn: AsyncConnection,
    *,
    owner_id: UUID,
    recording_id: UUID,
    markers: list[dict[str, Any]],
    device_name: str | None,
    created_by: UUID,
) -> None:
    """Grava o lote; um `client_id` já conhecido atualiza só a nota (o último do lote vale)."""
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
            # Um reenvio sem nota não apaga a nota editada depois (na web).
            set_={"note": func.coalesce(statement.excluded.note, t.markers.c.note), "updated_at": func.now()},
        )
    )


async def list_markers(conn: AsyncConnection, recording_id: UUID) -> list[Row]:
    """Os marcadores da gravação, em ordem de `at_ms`."""
    m = t.markers.c
    query = select(t.markers).where(m.recording_id == recording_id).order_by(m.at_ms, m.id)
    return list((await conn.execute(query)).mappings().all())
