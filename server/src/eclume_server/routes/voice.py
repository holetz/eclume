"""Identificação por voz (LGPD): consentimento, impressão, exportação, recusa de sugestão e auditoria.

Toda rota aqui aceita só sessão: um PAT nunca lê, exporta nem apaga dado biométrico. Regras em
docs/standards/code/identificacao-por-voz.md.
"""

from __future__ import annotations

import json
import re
import unicodedata
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Response
from pydantic import BaseModel, Field
from sqlalchemy import select, text, tuple_, update

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.pagination import Cursor, Limit, decode_cursor, iso, page
from eclume_server.people import get_person, person_json
from eclume_server.problems import not_found
from eclume_server.routes.transcripts import SPEAKER_ID, speaker_response
from eclume_server.serialize import user_ref
from eclume_server.transcripts import bump_revision, editable_transcript
from eclume_server.voice import SpeakerKey, audit, forget, org_voice, reject

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Member = Annotated[Principal, Depends(requires(session_only=True))]
Admin = Annotated[Principal, Depends(requires(session_only=True, admin=True))]


class VoiceConsentPut(BaseModel):
    """Schema `VoiceConsentPut`."""

    status: Literal["granted", "revoked"]
    notes: str | None = Field(default=None, max_length=2000)


def _ref(user_id: Any, name: str | None) -> dict[str, str] | None:  # noqa: ANN401 — UUID ou nulo
    return user_ref(user_id, name) if user_id and name else None


# --- sugestões ----------------------------------------------------------------------------------


@router.delete("/transcripts/{transcript_id}/speakers/{speaker_id}/suggestions/{person_id}")
async def reject_speaker_suggestion(
    transcript_id: UUID,
    speaker_id: Annotated[str, Path(pattern=SPEAKER_ID)],
    person_id: UUID,
    principal: Member,
    ctx: Ctx,
) -> dict[str, Any]:
    """Recusa a sugestão: some do locutor e não volta. Só o dono da gravação."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        await editable_transcript(conn, transcript_id, principal)
        if not await reject(conn, principal, SpeakerKey(transcript_id, speaker_id), person_id):
            raise not_found("Sugestão inexistente ou já decidida.")
        await bump_revision(conn, transcript_id)
        return await speaker_response(conn, transcript_id, speaker_id)


# --- consentimento e impressão ------------------------------------------------------------------


@router.put("/people/{person_id}/voice-consent")
async def set_voice_consent(person_id: UUID, body: VoiceConsentPut, principal: Member, ctx: Ctx) -> dict[str, Any]:
    """Registra o consentimento com o termo em vigor; revogar apaga a impressão e as sugestões pendentes."""
    now = datetime.now(UTC)
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        await get_person(conn, person_id)
        settings = await org_voice(conn, principal.org_id)
        version = str(settings["consent_term_version"])
        await conn.execute(
            t.voice_consents.insert().values(
                org_id=principal.org_id,
                person_id=person_id,
                status=body.status,
                term_version=version,
                term_text=settings["consent_term_text"],
                notes=body.notes,
                recorded_by=principal.user_id,
            )
        )
        await conn.execute(
            update(t.people)
            .where(t.people.c.id == person_id)
            .values(
                voice_consent_status=body.status,
                voice_consent_updated_at=now,
                voice_consent_term_version=version,
                voice_consent_by=principal.user_id,
            )
        )
        details: dict[str, Any] = {"term_version": version}
        if body.status == "revoked":
            samples, suggestions = await forget(conn, person_id)
            details |= {"deleted_samples": samples, "deleted_suggestions": suggestions}
        await audit(
            conn,
            principal.org_id,
            f"consent_{body.status}",
            person_id=person_id,
            actor_id=principal.user_id,
            details=details,
        )
        return person_json(await get_person(conn, person_id))


_SAMPLES = """
    SELECT s.transcript_id, r.title AS recording_title, s.speaker_id, s.model, s.talk_ms,
           s.created_by, u.name AS created_by_name, s.created_at{vector}
    FROM voice_samples s
    LEFT JOIN transcripts tr ON tr.id = s.transcript_id
    LEFT JOIN recordings r ON r.id = tr.recording_id
    LEFT JOIN users u ON u.id = s.created_by
    WHERE s.person_id = :person
    ORDER BY s.created_at DESC, s.transcript_id, s.speaker_id
    """
# O vetor só é lido na exportação (admin); a página da pessoa nunca o carrega.
_SAMPLES_PLAIN = text(_SAMPLES.format(vector=""))
_SAMPLES_WITH_VECTORS = text(_SAMPLES.format(vector=", s.embedding::text AS embedding"))


def _sample_json(row: Any, *, embedding: bool) -> dict[str, Any]:  # noqa: ANN401 — linha do SQLAlchemy
    body = {
        "transcript_id": str(row.transcript_id),
        "recording_title": row.recording_title,
        "speaker_id": row.speaker_id,
        "model": row.model,
        "talk_ms": row.talk_ms,
        "created_by": _ref(row.created_by, row.created_by_name),
        "created_at": iso(row.created_at),
    }
    if embedding:
        body["embedding"] = json.loads(row.embedding)
    return body


@router.get("/people/{person_id}/voiceprint")
async def get_voiceprint(person_id: UUID, principal: Member, ctx: Ctx) -> dict[str, Any]:
    """As amostras da impressão, sem os vetores; o título só de gravação visível."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        person = person_json(await get_person(conn, person_id))
        settings = await org_voice(conn, principal.org_id)
        rows = (await conn.execute(_SAMPLES_PLAIN, {"person": person_id})).all()
    samples = [_sample_json(row, embedding=False) for row in rows]
    return {
        "person_id": str(person_id),
        "consent": person["voice_consent"],
        "opt_in": bool(settings["enabled"]),
        "term": {"version": str(settings["consent_term_version"]), "text": settings["consent_term_text"]},
        "sample_count": len(samples),
        "samples": samples,
    }


@router.delete("/people/{person_id}/voiceprint", status_code=204)
async def delete_voiceprint(person_id: UUID, principal: Member, ctx: Ctx) -> Response:
    """Apaga todas as amostras e as sugestões pendentes da pessoa; o consentimento fica."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        await get_person(conn, person_id)
        samples, suggestions = await forget(conn, person_id)
        await audit(
            conn,
            principal.org_id,
            "voiceprint_deleted",
            person_id=person_id,
            actor_id=principal.user_id,
            details={"deleted_samples": samples, "deleted_suggestions": suggestions},
        )
    return Response(status_code=204)


def _filename(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return f"voz-{re.sub(r'[^a-z0-9]+', '-', ascii_name.lower()).strip('-') or 'pessoa'}.json"


def _audit_json(row: Any) -> dict[str, Any]:  # noqa: ANN401 — linha do SQLAlchemy
    return {
        "id": str(row["id"]),
        "event": row["event"],
        "person": {"id": str(row["person_id"]), "name": row["person_name"]}
        if row["person_id"] and row["person_name"]
        else None,
        "actor": _ref(row["actor_id"], row["actor_name"]),
        "transcript_id": str(row["transcript_id"]) if row["transcript_id"] else None,
        "speaker_id": row["speaker_id"],
        "score": row["score"],
        "details": row["details"],
        "created_at": iso(row["created_at"]),
    }


def _audit_select() -> Any:  # noqa: ANN401 — Select do SQLAlchemy
    a = t.voice_audit
    return select(a, t.users.c.name.label("actor_name")).select_from(a.outerjoin(t.users, t.users.c.id == a.c.actor_id))


@router.get("/people/{person_id}/voiceprint/export")
async def export_voiceprint(person_id: UUID, principal: Admin, ctx: Ctx) -> Response:
    """Consentimentos, amostras com vetores e auditoria da pessoa, para download (direito de acesso)."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        person = await get_person(conn, person_id)
        c = t.voice_consents.c
        consents = (
            await conn.execute(
                select(t.voice_consents, t.users.c.name.label("recorded_by_name"))
                .select_from(t.voice_consents.outerjoin(t.users, t.users.c.id == c.recorded_by))
                .where(c.person_id == person_id)
                .order_by(c.recorded_at, c.id)
            )
        ).mappings()
        consent_items = [
            {
                "status": row["status"],
                "term_version": row["term_version"],
                "term_text": row["term_text"],
                "notes": row["notes"],
                "recorded_by": _ref(row["recorded_by"], row["recorded_by_name"]),
                "recorded_at": iso(row["recorded_at"]),
            }
            for row in consents
        ]
        samples = [
            _sample_json(row, embedding=True)
            for row in await conn.execute(_SAMPLES_WITH_VECTORS, {"person": person_id})
        ]
        await audit(conn, principal.org_id, "exported", person_id=person_id, actor_id=principal.user_id)
        a = t.voice_audit.c
        events = (
            await conn.execute(
                _audit_select().where(a.person_id == person_id).order_by(a.created_at.desc(), a.id.desc())
            )
        ).mappings()
        exporter = (await conn.execute(select(t.users.c.name).where(t.users.c.id == principal.user_id))).scalar_one()
        body = {
            "exported_at": iso(datetime.now(UTC)),
            "exported_by": user_ref(principal.user_id, exporter),
            "person": {"id": str(person["id"]), "name": person["name"], "email": person["email"]},
            "consents": consent_items,
            "samples": samples,
            "audit": [_audit_json(row) for row in events],
        }
    return Response(
        json.dumps(body, ensure_ascii=False),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{_filename(person["name"])}"'},
    )


# --- admin --------------------------------------------------------------------------------------


@router.get("/admin/voice-audit")
async def list_voice_audit(
    principal: Admin, ctx: Ctx, person: UUID | None = None, cursor: Cursor = None, limit: Limit = 50
) -> dict[str, Any]:
    """Eventos de voz da organização, do mais novo ao mais antigo."""
    a = t.voice_audit.c
    query = _audit_select().order_by(a.created_at.desc(), a.id.desc()).limit(limit + 1)
    if person is not None:
        query = query.where(a.person_id == person)
    if cursor:
        query = query.where(tuple_(a.created_at, a.id) < decode_cursor(cursor))
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        rows = list((await conn.execute(query)).mappings().all())
    return page([_audit_json(row) for row in rows], rows, limit, "created_at")


@router.delete("/admin/voiceprints")
async def purge_voiceprints(principal: Admin, ctx: Ctx) -> dict[str, int]:
    """Apaga as impressões de todas as pessoas da organização e as sugestões pendentes."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        samples, suggestions = await forget(conn, None)
        details = {"deleted_samples": samples, "deleted_suggestions": suggestions}
        await audit(conn, principal.org_id, "org_purged", actor_id=principal.user_id, details=details)
    return details
