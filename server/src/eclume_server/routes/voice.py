"""Voice identification (LGPD): a person's voiceprint and declining a suggestion.

Every route here accepts only a session: a PAT never reads or deletes biometric data. Everything
belongs to the owner: RLS shows only the account's people, samples and transcripts. Rules in
docs/standards/code/identificacao-por-voz.md.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text, update

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.pagination import iso
from eclume_server.people import get_person
from eclume_server.problems import invalid_field, not_found
from eclume_server.routes.transcripts import SPEAKER_ID, speaker_response
from eclume_server.serialize import user_ref
from eclume_server.transcripts import bump_revision, editable_transcript
from eclume_server.voice import (
    MAX_AUTO_THRESHOLD,
    MIN_AUTO_THRESHOLD,
    SpeakerKey,
    auto_prefs,
    forget,
    forget_sample,
    keeps_samples,
    platform_voice,
    purge_account,
    reject,
    voice_counts,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Member = Annotated[Principal, Depends(requires(session_only=True))]


# --- suggestions --------------------------------------------------------------------------------


@router.delete("/transcripts/{transcript_id}/speakers/{speaker_id}/suggestions/{person_id}")
async def reject_speaker_suggestion(
    transcript_id: UUID,
    speaker_id: Annotated[str, Path(pattern=SPEAKER_ID)],
    person_id: UUID,
    principal: Member,
    ctx: Ctx,
) -> dict[str, Any]:
    """Decline the suggestion: it disappears from the speaker and does not come back."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await editable_transcript(conn, transcript_id)
        if not await reject(conn, principal, SpeakerKey(transcript_id, speaker_id), person_id):
            raise not_found("Sugestão inexistente ou já decidida.")
        await bump_revision(conn, transcript_id)
        return await speaker_response(conn, transcript_id, speaker_id)


# --- voiceprint ---------------------------------------------------------------------------------

_SAMPLES = text(
    """
    SELECT s.transcript_id, r.id AS recording_id, r.title AS recording_title, s.speaker_id, s.model,
           s.talk_ms, excerpt.start_ms AS excerpt_start_ms, excerpt.end_ms AS excerpt_end_ms,
           s.created_by, (SELECT name FROM users WHERE id = eclume_user()) AS created_by_name, s.created_at
    FROM voice_samples s
    LEFT JOIN transcripts tr ON tr.id = s.transcript_id
    LEFT JOIN recordings r ON r.id = tr.recording_id
    -- A fala mais longa do locutor: o trecho para ouvir a amostra.
    LEFT JOIN LATERAL (
        SELECT g.start_ms, g.end_ms FROM segments g
        WHERE g.transcript_id = s.transcript_id AND g.speaker_id = s.speaker_id
        ORDER BY g.end_ms - g.start_ms DESC, g.start_ms
        LIMIT 1
    ) excerpt ON true
    WHERE s.person_id = :person
    ORDER BY s.created_at DESC, s.transcript_id, s.speaker_id
    """
)


def _sample_json(row: Any) -> dict[str, Any]:  # noqa: ANN401 — an SQLAlchemy row
    return {
        "transcript_id": str(row.transcript_id),
        "recording_id": str(row.recording_id) if row.recording_id else None,
        "recording_title": row.recording_title,
        "speaker_id": row.speaker_id,
        "model": row.model,
        "talk_ms": row.talk_ms,
        "excerpt": (
            {"start_ms": row.excerpt_start_ms, "end_ms": row.excerpt_end_ms}
            if row.recording_id and row.excerpt_start_ms is not None
            else None
        ),
        "created_by": user_ref(row.created_by, row.created_by_name) if row.created_by and row.created_by_name else None,
        "created_at": iso(row.created_at),
    }


@router.get("/people/{person_id}/voiceprint")
async def get_voiceprint(person_id: UUID, principal: Member, ctx: Ctx) -> dict[str, Any]:
    """The voiceprint's samples, without the vectors."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await get_person(conn, person_id)
        settings = await platform_voice(conn)
        rows = (await conn.execute(_SAMPLES, {"person": person_id})).all()
    samples = [_sample_json(row) for row in rows]
    return {
        "person_id": str(person_id),
        "enabled": bool(settings["enabled"]),
        "sample_count": len(samples),
        "samples": samples,
    }


@router.delete("/people/{person_id}/voiceprint", status_code=204)
async def delete_voiceprint(person_id: UUID, principal: Member, ctx: Ctx) -> Response:
    """Forget the person's voice: delete their samples and pending suggestions."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await get_person(conn, person_id)
        await forget(conn, person_id)
    return Response(status_code=204)


@router.delete("/people/{person_id}/voice-samples/{transcript_id}/{speaker_id}", status_code=204)
async def delete_voice_sample(
    person_id: UUID,
    transcript_id: UUID,
    speaker_id: Annotated[str, Path(pattern=SPEAKER_ID)],
    principal: Member,
    ctx: Ctx,
) -> Response:
    """Remove a sample from the voiceprint; the speaker stays linked to the person."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await get_person(conn, person_id)
        if not await forget_sample(conn, person_id, SpeakerKey(transcript_id, speaker_id)):
            raise not_found("Amostra inexistente ou sem acesso.")
    return Response(status_code=204)


# --- automatic assignment -----------------------------------------------------------------------


class VoiceAssignmentPatch(BaseModel):
    """Body of `PATCH /me/voice-assignment`: the fields sent change, the others stay."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool | None = None
    threshold: float | None = Field(default=None, ge=MIN_AUTO_THRESHOLD, le=MAX_AUTO_THRESHOLD)
    keep_samples: bool | None = None


async def _assignment_json(conn: AsyncConnection, user_id: UUID) -> dict[str, Any]:
    """Schema `VoiceAssignment`; `platform_enabled` says whether the platform lets voice apply."""
    prefs = await auto_prefs(conn, user_id)
    samples, people = await voice_counts(conn, user_id)
    return {
        "enabled": prefs.enabled,
        "threshold": round(prefs.threshold, 4),
        "platform_enabled": (await platform_voice(conn))["enabled"],
        "keep_samples": await keeps_samples(conn, user_id),
        "sample_count": samples,
        "voiceprint_people": people,
    }


@router.get("/me/voice-assignment")
async def get_voice_assignment(principal: Member, ctx: Ctx) -> dict[str, Any]:
    """The account's preference: link the speaker to the person on its own, the minimum score, and keeping samples."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await _assignment_json(conn, principal.user_id)


@router.patch("/me/voice-assignment")
async def patch_voice_assignment(body: VoiceAssignmentPatch, principal: Member, ctx: Ctx) -> dict[str, Any]:
    """Change the preference; it applies to future transcripts, without touching existing links.

    `keep_samples: false` immediately deletes the account's samples, vectors and pending suggestions
    (LGPD: the data subject's choice); the account's `speaker_embeddings.json` files go in the CPU worker.
    """
    values = body.model_dump(exclude_unset=True)
    if any(value is None for value in values.values()):
        raise invalid_field("body", "os campos não aceitam null")
    if not values:
        raise invalid_field("body", "informe ao menos um campo")
    columns = {
        "enabled": "voice_auto_assign",
        "threshold": "voice_auto_threshold",
        "keep_samples": "voice_keep_samples",
    }
    user_id = principal.user_id
    async with user_tx(ctx.engine, user_id) as conn:
        turned_off = values.get("keep_samples") is False and await keeps_samples(conn, user_id)
        await conn.execute(
            update(t.users).where(t.users.c.id == user_id).values({columns[k]: v for k, v in values.items()})
        )
        if turned_off:
            await purge_account(conn, user_id)
        result = await _assignment_json(conn, user_id)
    if turned_off:
        await ctx.queue.enqueue_purge_embedding_objects(user_id)
    return result
