"""Etapas do processamento de uma gravação (`pipeline_steps`), por revisão do job de transcrição.

recebido → pré-processamento → transcrição → campos → tipo de agenda → resumo. Cada etapa fica
`pending`, `active`, `done`, `failed` ou `skipped`, com o motivo quando pulada ou falha. Contrato e
decisões em docs/standards/code/processamento-automatico.md.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from eclume_server.db import tables as t
from eclume_server.pagination import iso

if TYPE_CHECKING:
    from datetime import datetime
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

STEPS = ("received", "preprocessing", "transcription", "fields", "agenda_type", "summary")
FINISHED = ("done", "failed", "skipped")
# Etapa do worker GPU (hash de progresso, já no vocabulário de `Job.stage`) → etapa em andamento.
_ACTIVE_BY_STAGE = {"preprocessing": "preprocessing"}


async def set_step(  # noqa: PLR0913 — a etapa, o estado e o que ele carrega
    conn: AsyncConnection,
    recording: Row,
    revision: int,
    step: str,
    state: str,
    *,
    error: tuple[str, str] | None = None,
    detail: dict[str, Any] | None = None,
    started_at: datetime | None = None,
    finished_at: datetime | None = None,
) -> None:
    """Grava o estado da etapa; `active` marca o início, e um estado final, o fim.

    `recording` traz `id` e `owner_id`. Serve às rotas (sob a RLS do dono) e aos workers (papel de
    conexão).
    """
    ps = t.pipeline_steps
    now = func.now()
    values: dict[str, Any] = {
        "state": state,
        "error_code": error[0] if error else None,
        "error_message": error[1] if error else None,
        "detail": detail or {},
    }
    if state == "active":
        values |= {"started_at": started_at or now, "finished_at": None}
    elif state in FINISHED:
        values |= {"started_at": started_at or now, "finished_at": finished_at or now}
    update_values = dict(values)
    if state in FINISHED and started_at is None:
        # Terminar uma etapa que já tinha começado mantém o início dela.
        update_values["started_at"] = func.coalesce(ps.c.started_at, now)
    await conn.execute(
        pg_insert(ps)
        .values(owner_id=recording["owner_id"], recording_id=recording["id"], revision=revision, step=step, **values)
        .on_conflict_do_update(index_elements=[ps.c.recording_id, ps.c.revision, ps.c.step], set_=update_values)
    )


def _step_json(step: str, row: Row | None) -> dict[str, Any]:
    if row is None:
        return {
            "step": step,
            "state": "pending",
            "started_at": None,
            "finished_at": None,
            "duration_ms": None,
            "error": None,
            "reason": None,
        }
    error = {"code": row["error_code"], "message": row["error_message"] or ""} if row["error_code"] else None
    return {
        "step": step,
        "state": row["state"],
        "started_at": iso(row["started_at"]),
        "finished_at": iso(row["finished_at"]),
        "duration_ms": row["duration_ms"],
        "error": error,
        "reason": (row["detail"] or {}).get("reason"),
    }


async def load_pipelines(conn: AsyncConnection, recording_ids: list[UUID]) -> dict[UUID, list[Row]]:
    """As linhas da maior revisão de cada gravação."""
    if not recording_ids:
        return {}
    ps = t.pipeline_steps.c
    latest = (
        select(ps.recording_id, func.max(ps.revision).label("revision"))
        .where(ps.recording_id.in_(recording_ids))
        .group_by(ps.recording_id)
        .subquery()
    )
    rows = (
        (
            await conn.execute(
                select(t.pipeline_steps).join(
                    latest, (latest.c.recording_id == ps.recording_id) & (latest.c.revision == ps.revision)
                )
            )
        )
        .mappings()
        .all()
    )
    by_recording: dict[UUID, list[Row]] = {}
    for row in rows:
        by_recording.setdefault(row["recording_id"], []).append(row)
    return by_recording


def pipeline_json(rows: list[Row], running_stage: str | None) -> list[dict[str, Any]]:
    """Schema `PipelineStep[]`: as seis etapas em ordem; sem linha, `pending`.

    `running_stage` é a etapa de `Job.stage` enquanto o worker GPU reporta progresso: ela deixa o
    pré-processamento ou a transcrição `active`.
    """
    by_step = {row["step"]: row for row in rows}
    steps = [_step_json(step, by_step.get(step)) for step in STEPS]
    if running_stage is not None:
        active = _ACTIVE_BY_STAGE.get(running_stage, "transcription")
        for item in steps:
            if item["step"] == active and item["state"] == "pending":
                item["state"] = "active"
    return steps


async def get_step(conn: AsyncConnection, recording_id: UUID, revision: int, step: str) -> Row | None:
    """A linha da etapa, se já existe."""
    ps = t.pipeline_steps.c
    query = select(t.pipeline_steps).where(ps.recording_id == recording_id, ps.revision == revision, ps.step == step)
    return (await conn.execute(query)).mappings().first()
