"""Transcripts: incremental listing (`?since=`), reading, Markdown export and editing by the owner."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, exists, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncConnection

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.exports import slug
from eclume_server.input_limits import MAX_SEGMENT_TEXT
from eclume_server.pagination import Cursor, Limit, decode_cursor, page
from eclume_server.people import get_person
from eclume_server.problems import ApiProblemError, invalid_field, not_found
from eclume_server.speaker_naming import release_if_named
from eclume_server.transcripts import (
    bump_revision,
    editable_transcript,
    load_speakers,
    load_transcript,
    recompute_talk,
    render_markdown,
    segment_json,
    speaker_json,
    speakers_select,
    summary_json,
    transcript_select,
)
from eclume_server.voice import SpeakerKey, load_suggestions, on_link

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("transcripts:read"))]
Editor = Annotated[Principal, Depends(requires("transcripts:write"))]
SPEAKER_ID = r"^S[0-9]+$"
SpeakerId = Annotated[str, Field(pattern=SPEAKER_ID)]


class SpeakerPatch(BaseModel):
    """Schema `SpeakerPatch`."""

    label: str | None = Field(default=None, min_length=1)
    person_id: UUID | None = None


class SpeakerMerge(BaseModel):
    """Schema `SpeakerMerge`."""

    source_speaker_ids: list[SpeakerId] = Field(min_length=1)
    target_speaker_id: SpeakerId


class SegmentPatch(BaseModel):
    """Schema `SegmentPatch`."""

    text: str | None = Field(default=None, max_length=MAX_SEGMENT_TEXT)
    speaker_id: SpeakerId | None = None


@router.get("/transcripts")
async def list_transcripts(
    principal: Reader,
    ctx: Ctx,
    cursor: Cursor = None,
    limit: Limit = 50,
    since: datetime | None = None,
    person: UUID | None = None,
    recording_id: UUID | None = None,
) -> dict[str, Any]:
    """The user's transcripts, in ascending `(updated_at, id)` order; `since` is inclusive."""
    c = t.transcripts.c
    query = transcript_select().order_by(c.updated_at, c.id).limit(limit + 1)
    if since is not None:
        query = query.where(c.updated_at >= since)
    if recording_id is not None:
        query = query.where(c.recording_id == recording_id)
    if person is not None:
        query = query.where(exists().where(t.speakers.c.transcript_id == c.id, t.speakers.c.person_id == person))
    if cursor:
        query = query.where(tuple_(c.updated_at, c.id) > decode_cursor(cursor))
    async with user_tx(ctx.engine, principal.user_id) as conn:
        rows = list((await conn.execute(query)).mappings().all())
        speakers = await load_speakers(conn, [row["id"] for row in rows[:limit]])
    items = [summary_json(row, speakers.get(row["id"], [])) for row in rows]
    return page(items, rows, limit, "updated_at")


@router.get("/transcripts/{transcript_id}")
async def get_transcript(
    transcript_id: UUID, principal: Reader, ctx: Ctx, include: Literal["words"] | None = None
) -> dict[str, Any]:
    """Full transcript; `include=words` brings the timed words."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await load_transcript(conn, transcript_id, words=include == "words")


@router.get("/transcripts/{transcript_id}/export")
async def export_transcript(
    transcript_id: UUID,
    export_format: Annotated[Literal["md"], Query(alias="format")],
    principal: Reader,
    ctx: Ctx,
) -> Response:
    """Exports the transcript (`md`: YAML frontmatter and one line per segment)."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        transcript = await load_transcript(conn, transcript_id, words=False)
    del export_format  # only `md` exists in v1; new formats come in additively
    return Response(
        render_markdown(transcript),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{slug(transcript["title"])}.md"'},
    )


def _patch_values(body: BaseModel) -> dict[str, Any]:
    """Fields sent (`minProperties: 1`); `null` only holds where the schema allows it."""
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise invalid_field("body", "informe ao menos um campo")
    for field, value in values.items():
        if value is None and field != "person_id":
            raise invalid_field(field, "não pode ser nulo")
    return values


async def _speaker_ids(conn: AsyncConnection, transcript_id: UUID) -> set[str]:
    query = select(t.speakers.c.speaker_id).where(t.speakers.c.transcript_id == transcript_id)
    return set((await conn.execute(query)).scalars())


@router.patch("/transcripts/{transcript_id}/speakers/{speaker_id}")
async def update_speaker(
    transcript_id: UUID,
    speaker_id: Annotated[str, Path(pattern=SPEAKER_ID)],
    body: SpeakerPatch,
    principal: Editor,
    ctx: Ctx,
) -> dict[str, Any]:
    """Renames the speaker and/or links it to a person (`null` undoes); linking without `label` uses the person's name."""
    values = _patch_values(body)
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await editable_transcript(conn, transcript_id)
        where = (t.speakers.c.transcript_id == transcript_id, t.speakers.c.speaker_id == speaker_id)
        current = (await conn.execute(select(t.speakers.c.person_id).where(*where))).first()
        if current is None:
            raise not_found("Locutor inexistente nesta transcrição.")
        if values.get("person_id") is not None:
            try:
                person = await get_person(conn, values["person_id"])
            except ApiProblemError as exc:
                raise invalid_field("person_id", "pessoa inexistente") from exc
            values.setdefault("label", person["name"])
        if "person_id" in values:
            # Linking, confirming or unlinking is a person's decision: it stops being an automatic link.
            values["auto_score"] = None
        await conn.execute(update(t.speakers).where(*where).values(**values))
        if "person_id" in values:
            key = SpeakerKey(transcript_id, speaker_id)
            await on_link(conn, principal, key, values["person_id"])
        await bump_revision(conn, transcript_id)
        released = await _release(conn, transcript_id) if "person_id" in values else None
        response = await speaker_response(conn, transcript_id, speaker_id)
    await _resume_chain(ctx, released)
    return response


async def _release(conn: AsyncConnection, transcript_id: UUID) -> tuple[UUID, int] | None:
    """Releases the recording held waiting for names once the last speaker got a person."""
    recording_id = (
        await conn.execute(select(t.transcripts.c.recording_id).where(t.transcripts.c.id == transcript_id))
    ).scalar_one()
    revision = await release_if_named(conn, recording_id)
    return (recording_id, revision) if revision is not None else None


async def _resume_chain(ctx: AppContext, released: tuple[UUID, int] | None) -> None:
    """After the commit, the agent chain proceeds by agenda type."""
    if released is not None:
        await ctx.queue.enqueue_step("detect_agenda_type", *released)


async def speaker_response(conn: AsyncConnection, transcript_id: UUID, speaker_id: str) -> dict[str, Any]:
    """Schema `Speaker` of the speaker, with the pending suggestions."""
    where = (t.speakers.c.transcript_id == transcript_id, t.speakers.c.speaker_id == speaker_id)
    row = (await conn.execute(speakers_select().where(*where))).mappings().one()
    suggestions = await load_suggestions(conn, [transcript_id])
    return speaker_json({**row, "suggestions": suggestions.get((transcript_id, speaker_id), [])})


@router.post("/transcripts/{transcript_id}/speakers/merge")
async def merge_speakers(transcript_id: UUID, body: SpeakerMerge, principal: Editor, ctx: Ctx) -> dict[str, Any]:
    """Moves the segments of the source speakers to the target one and deletes the source ones."""
    sources = set(body.source_speaker_ids)
    if len(sources) != len(body.source_speaker_ids):
        raise invalid_field("source_speaker_ids", "ids repetidos")
    if body.target_speaker_id in sources:
        raise invalid_field("source_speaker_ids", "o destino não pode estar entre as origens")
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await editable_transcript(conn, transcript_id)
        existing = await _speaker_ids(conn, transcript_id)
        if body.target_speaker_id not in existing:
            raise invalid_field("target_speaker_id", "locutor inexistente")
        if not sources <= existing:
            raise invalid_field("source_speaker_ids", f"locutor inexistente: {', '.join(sorted(sources - existing))}")
        await conn.execute(
            update(t.segments)
            .where(t.segments.c.transcript_id == transcript_id, t.segments.c.speaker_id.in_(sources))
            .values(speaker_id=body.target_speaker_id)
        )
        # The voiceprint of whoever disappears no longer describes anyone.
        for table in (t.speaker_embeddings, t.speakers):
            await conn.execute(
                delete(table).where(table.c.transcript_id == transcript_id, table.c.speaker_id.in_(sources))
            )
        await recompute_talk(conn, transcript_id, {body.target_speaker_id})
        await bump_revision(conn, transcript_id)
        # Merging a speaker with no person into a named one can also clear what was missing.
        released = await _release(conn, transcript_id)
        response = await load_transcript(conn, transcript_id, words=False)
    await _resume_chain(ctx, released)
    return response


@router.patch("/transcripts/{transcript_id}/segments/{segment_id}")
async def update_segment(
    transcript_id: UUID, segment_id: str, body: SegmentPatch, principal: Editor, ctx: Ctx
) -> dict[str, Any]:
    """Fixes the text (discards the `words`) and/or changes the segment's speaker."""
    values = _patch_values(body)
    where = (t.segments.c.transcript_id == transcript_id, t.segments.c.segment_id == segment_id)
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await editable_transcript(conn, transcript_id)
        current = (await conn.execute(select(t.segments.c.speaker_id).where(*where))).scalar()
        if current is None:
            raise not_found("Segmento inexistente nesta transcrição.")
        if "speaker_id" in values and values["speaker_id"] not in await _speaker_ids(conn, transcript_id):
            raise invalid_field("speaker_id", "locutor inexistente")
        if "text" in values:
            values["words"] = None
        await conn.execute(update(t.segments).where(*where).values(**values))
        if values.get("speaker_id", current) != current:
            await recompute_talk(conn, transcript_id, {current, values["speaker_id"]})
        await bump_revision(conn, transcript_id)
        row = (await conn.execute(select(t.segments).where(*where))).mappings().one()
    return segment_json(row, words=False)
