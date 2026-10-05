"""Marcação obrigatória dos locutores: a etapa `speakers` do pipeline (holetz/eclume#144).

Com `users.require_speaker_naming` ligada, a ingestão para a cadeia por agente quando algum locutor
com fala suficiente ficou sem pessoa: a etapa `speakers` fica `waiting` (`unnamed_speakers`) e o
tipo de agenda não é enfileirado. Ela sai da espera quando o dono liga a última pessoa que faltava
(`done`), quando solta a gravação (`continued_by_user`) ou quando desliga a preferência
(`naming_not_required`); quem chama enfileira `detect_agenda_type` depois do commit. Regras em
docs/standards/code/processamento-automatico.md §Marcação dos locutores.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select, update

from eclume_server.db import tables as t
from eclume_server.pipeline import current_revision, get_step, set_step

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection
    from sqlalchemy.sql import ColumnElement, Select

    from eclume_server.serialize import Row

STEP = "speakers"
WAITING = "waiting"
# Fragmentos de diarização não prendem a gravação: o mesmo piso da comparação por voz.
MIN_REQUIRED_TALK_MS = 10_000
UNNAMED = "unnamed_speakers"
CONTINUED = "continued_by_user"
NOT_REQUIRED = "naming_not_required"


async def required(conn: AsyncConnection, owner_id: UUID) -> bool:
    """Se a conta exige a marcação dos locutores."""
    query = select(t.users.c.require_speaker_naming).where(t.users.c.id == owner_id)
    return bool((await conn.execute(query)).scalar())


async def unnamed_count(conn: AsyncConnection, transcript_id: UUID) -> int:
    """Quantos locutores da transcrição, com pelo menos `MIN_REQUIRED_TALK_MS` de fala, estão sem pessoa."""
    s = t.speakers.c
    query = (
        select(func.count())
        .select_from(t.speakers)
        .where(
            s.transcript_id == transcript_id,
            s.person_id.is_(None),
            func.coalesce(s.talk_ms, 0) >= MIN_REQUIRED_TALK_MS,
        )
    )
    return int((await conn.execute(query)).scalar_one())


async def gate(conn: AsyncConnection, recording: Row, revision: int, transcript_id: UUID) -> bool:
    """Grava a etapa `speakers` da revisão recém-ingerida; `True` quando a cadeia para nela.

    Roda na transação da ingestão, depois da restauração dos vínculos e da atribuição pela voz.
    """
    unnamed = await unnamed_count(conn, transcript_id) if await required(conn, recording["owner_id"]) else 0
    if unnamed:
        await set_step(conn, recording, revision, STEP, WAITING, detail={"reason": UNNAMED, "unnamed": unnamed})
        return True
    await set_step(conn, recording, revision, STEP, "done")
    return False


async def _waiting_revision(conn: AsyncConnection, recording_id: UUID) -> tuple[Row, int] | None:
    """`(gravação, revisão)` quando a revisão atual da gravação está parada nos locutores."""
    recording = (
        (await conn.execute(select(t.recordings.c.id, t.recordings.c.owner_id).where(t.recordings.c.id == recording_id)))
        .mappings()
        .first()
    )
    if recording is None:
        return None
    revision = await current_revision(conn, recording_id)
    if revision is None:
        return None
    step = await get_step(conn, recording_id, revision, STEP)
    if step is None or step["state"] != WAITING:
        return None
    return dict(recording), revision


async def release_if_named(conn: AsyncConnection, recording_id: UUID) -> int | None:
    """Solta a gravação parada quando nenhum locutor obrigatório ficou sem pessoa; devolve a revisão."""
    waiting = await _waiting_revision(conn, recording_id)
    if waiting is None:
        return None
    recording, revision = waiting
    transcript_id = (
        await conn.execute(select(t.transcripts.c.id).where(t.transcripts.c.recording_id == recording_id))
    ).scalar()
    unnamed = await unnamed_count(conn, transcript_id) if transcript_id is not None else 0
    if unnamed:
        # Ainda falta alguém: só a contagem do motivo acompanha. O instante da espera fica, para os
        # avisos de desfecho (que comparam o `finished_at`) não repetirem a cada pessoa ligada.
        ps = t.pipeline_steps.c
        await conn.execute(
            update(t.pipeline_steps)
            .where(ps.recording_id == recording_id, ps.revision == revision, ps.step == STEP)
            .values(detail={"reason": UNNAMED, "unnamed": unnamed})
        )
        return None
    await set_step(conn, recording, revision, STEP, "done")
    return revision


async def release(conn: AsyncConnection, recording_id: UUID, reason: str) -> int | None:
    """Solta a gravação parada sem exigir os nomes (`skipped` com `reason`); devolve a revisão."""
    waiting = await _waiting_revision(conn, recording_id)
    if waiting is None:
        return None
    recording, revision = waiting
    await set_step(conn, recording, revision, STEP, "skipped", detail={"reason": reason})
    return revision


def waiting_select() -> Select[Any]:
    """`(recording_id, revision)` das gravações cuja revisão atual está parada nos locutores."""
    ps = t.pipeline_steps.c
    jobs = t.transcription_jobs.c
    latest = select(func.max(jobs.revision)).where(jobs.recording_id == ps.recording_id).scalar_subquery()
    return select(ps.recording_id, ps.revision).where(ps.step == STEP, ps.state == WAITING, ps.revision == latest)


def awaiting_condition() -> ColumnElement[bool]:
    """A condição da biblioteca para `?awaiting=speakers`."""
    return t.recordings.c.id.in_(waiting_select().with_only_columns(t.pipeline_steps.c.recording_id))


async def waiting_count(conn: AsyncConnection) -> int:
    """Quantas gravações visíveis na transação estão paradas nos locutores."""
    return int((await conn.execute(select(func.count()).select_from(waiting_select().subquery()))).scalar_one())


async def release_account(conn: AsyncConnection, owner_id: UUID) -> list[tuple[UUID, int]]:
    """Solta todas as gravações paradas da conta (a preferência foi desligada)."""
    ps = t.pipeline_steps.c
    rows = (await conn.execute(waiting_select().where(ps.owner_id == owner_id))).all()
    released = []
    for recording_id, revision in rows:
        recording = {"id": recording_id, "owner_id": owner_id}
        await set_step(conn, recording, revision, STEP, "skipped", detail={"reason": NOT_REQUIRED})
        released.append((recording_id, revision))
    return released


def awaiting_of(pipeline: list[dict[str, Any]]) -> str | None:
    """`Recording.awaiting`: `"speakers"` quando a etapa dos locutores espera o dono."""
    return "speakers" if any(step["step"] == STEP and step["state"] == WAITING for step in pipeline) else None
