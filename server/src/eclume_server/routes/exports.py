"""Export of the recording as TXT, SRT, MD and DOCX.

Everything belongs to the owner: RLS shows only the account's recordings, transcripts and summaries.
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from starlette.concurrency import run_in_threadpool

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db.session import user_tx
from eclume_server.exports import MEDIA_TYPES, RENDERERS, load_export, slug
from eclume_server.problems import insufficient_scope

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("transcripts:read"))]
# The formats that carry the summary also require `summaries:read` on a PAT.
WITH_SUMMARY = {"md", "docx"}


@router.get("/recordings/{recording_id}/export")
async def export_recording(
    recording_id: UUID,
    export_format: Annotated[Literal["txt", "srt", "md", "docx"], Query(alias="format")],
    principal: Reader,
    ctx: Ctx,
) -> Response:
    """Export the transcript (`txt`, `srt`), the summary (`md`) or both (`docx`)."""
    if export_format in WITH_SUMMARY and principal.method == "pat" and "summaries:read" not in principal.scopes:
        raise insufficient_scope(["summaries:read"])
    async with user_tx(ctx.engine, principal.user_id) as conn:
        export = await load_export(conn, recording_id)
    # The DOCX of a long transcript takes seconds of CPU: off the event loop.
    body = await run_in_threadpool(RENDERERS[export_format], export)
    filename = f"{slug(export.title, 'gravacao')}.{export_format}"
    return Response(
        body,
        media_type=MEDIA_TYPES[export_format],
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
