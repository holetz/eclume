"""Identificação por voz (LGPD): impressão de voz da pessoa e recusa de sugestão.

Toda rota aqui aceita só sessão: um PAT nunca lê nem apaga dado biométrico. Tudo é do dono: a RLS
mostra só as pessoas, as amostras e as transcrições da conta. Regras em
docs/standards/code/identificacao-por-voz.md.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Response
from sqlalchemy import text

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db.session import user_tx
from eclume_server.pagination import iso
from eclume_server.people import get_person
from eclume_server.problems import not_found
from eclume_server.routes.transcripts import SPEAKER_ID, speaker_response
from eclume_server.serialize import user_ref
from eclume_server.transcripts import bump_revision, editable_transcript
from eclume_server.voice import SpeakerKey, forget, platform_voice, reject

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Member = Annotated[Principal, Depends(requires(session_only=True))]


# --- sugestões ----------------------------------------------------------------------------------


@router.delete("/transcripts/{transcript_id}/speakers/{speaker_id}/suggestions/{person_id}")
async def reject_speaker_suggestion(
    transcript_id: UUID,
    speaker_id: Annotated[str, Path(pattern=SPEAKER_ID)],
    person_id: UUID,
    principal: Member,
    ctx: Ctx,
) -> dict[str, Any]:
    """Recusa a sugestão: some do locutor e não volta."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await editable_transcript(conn, transcript_id)
        if not await reject(conn, principal, SpeakerKey(transcript_id, speaker_id), person_id):
            raise not_found("Sugestão inexistente ou já decidida.")
        await bump_revision(conn, transcript_id)
        return await speaker_response(conn, transcript_id, speaker_id)


# --- impressão ----------------------------------------------------------------------------------

_SAMPLES = text(
    """
    SELECT s.transcript_id, r.title AS recording_title, s.speaker_id, s.model, s.talk_ms,
           s.created_by, u.name AS created_by_name, s.created_at
    FROM voice_samples s
    LEFT JOIN transcripts tr ON tr.id = s.transcript_id
    LEFT JOIN recordings r ON r.id = tr.recording_id
    LEFT JOIN users u ON u.id = s.created_by
    WHERE s.person_id = :person
    ORDER BY s.created_at DESC, s.transcript_id, s.speaker_id
    """
)


def _sample_json(row: Any) -> dict[str, Any]:  # noqa: ANN401 — linha do SQLAlchemy
    return {
        "transcript_id": str(row.transcript_id),
        "recording_title": row.recording_title,
        "speaker_id": row.speaker_id,
        "model": row.model,
        "talk_ms": row.talk_ms,
        "created_by": user_ref(row.created_by, row.created_by_name) if row.created_by and row.created_by_name else None,
        "created_at": iso(row.created_at),
    }


@router.get("/people/{person_id}/voiceprint")
async def get_voiceprint(person_id: UUID, principal: Member, ctx: Ctx) -> dict[str, Any]:
    """As amostras da impressão, sem os vetores."""
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
    """Esquece a voz da pessoa: apaga as amostras e as sugestões pendentes dela."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await get_person(conn, person_id)
        await forget(conn, person_id)
    return Response(status_code=204)
