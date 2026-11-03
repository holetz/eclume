"""The recording's markers: list, send in a batch (idempotent), edit the note and delete.

Everything belongs to the owner: RLS shows only the account's recordings and markers.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, update

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.markers import (
    MAX_BATCH,
    MAX_NOTE,
    MarkerInput,
    list_markers,
    marker_json,
    touch_recording,
    upsert_markers,
)
from eclume_server.problems import not_found
from eclume_server.recordings import get_visible

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("recordings:read"))]
Writer = Annotated[Principal, Depends(requires("recordings:write"))]


class MarkerBatch(BaseModel):
    """Schema `MarkerBatch`."""

    markers: list[MarkerInput] = Field(min_length=1, max_length=MAX_BATCH)
    device_name: str | None = Field(default=None, max_length=200)


class MarkerPatch(BaseModel):
    """Schema `MarkerPatch`."""

    note: str | None = Field(max_length=MAX_NOTE)


def _page(rows: list[Any]) -> dict[str, Any]:
    return {"items": [marker_json(row) for row in rows], "next_cursor": None}


@router.get("/recordings/{recording_id}/markers")
async def get_markers(recording_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """The recording's markers, in `at_ms` order (single page)."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await get_visible(conn, recording_id)
        return _page(await list_markers(conn, recording_id))


@router.post("/recordings/{recording_id}/markers")
async def post_markers(recording_id: UUID, body: MarkerBatch, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Save the batch; resending the same `client_id` updates the note and does not duplicate."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        recording = await get_visible(conn, recording_id)
        await upsert_markers(
            conn,
            owner_id=recording["owner_id"],
            recording_id=recording_id,
            markers=[marker.model_dump() for marker in body.markers],
            device_name=body.device_name,
            created_by=principal.user_id,
        )
        return _page(await list_markers(conn, recording_id))


@router.patch("/markers/{marker_id}")
async def patch_marker(marker_id: UUID, body: MarkerPatch, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Replace the marker's note (`null` clears the note)."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        row = (
            (
                await conn.execute(
                    update(t.markers)
                    .where(t.markers.c.id == marker_id)
                    .values(note=body.note, updated_at=func.now())
                    .returning(t.markers)
                )
            )
            .mappings()
            .first()
        )
        if row is not None:
            await touch_recording(conn, row["recording_id"])
    if row is None:
        raise not_found("Marker does not exist or is not accessible.")
    return marker_json(row)


@router.delete("/markers/{marker_id}", status_code=204)
async def delete_marker(marker_id: UUID, principal: Writer, ctx: Ctx) -> Response:
    """Delete the marker."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        recording_id = (
            await conn.execute(delete(t.markers).where(t.markers.c.id == marker_id).returning(t.markers.c.recording_id))
        ).scalar()
        if recording_id is not None:
            await touch_recording(conn, recording_id)
    if recording_id is None:
        raise not_found("Marker does not exist or is not accessible.")
    return Response(status_code=204)
