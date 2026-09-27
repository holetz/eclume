"""Tipos de agenda: os do usuário (`agenda_types`) e os padrão da plataforma (`default_agenda_types`).

O tipo diz como reconhecer a gravação, que título e tags ela ganha e como resumi-la. Contrato e
decisões em docs/standards/code/processamento-automatico.md.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Annotated, Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select, update

from eclume_server.agents.extraction import TypeSpec, detect_type
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.pipeline import GONE, STALE, current_revision, get_step, set_step
from eclume_server.problems import invalid_field, not_found
from eclume_server.summaries import AgentStep, call_agent_step, load_provider, provider_for, transcript_text

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy import Table
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

Tag = Annotated[str, Field(min_length=1, max_length=64)]
# Não podem ser nulos num PATCH (os demais aceitam `null`, que limpa).
REQUIRED = ("name", "summary_instructions", "identify", "default_tags", "position")


class AgendaTypeDraft(BaseModel):
    """Schema `AgendaTypeDraft`: o conteúdo de um tipo, salvo ou em rascunho."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    title_pattern: str | None = Field(default=None, max_length=300)
    identify: str = ""
    default_tags: list[Tag] = Field(default_factory=list, max_length=20)
    summary_instructions: str = Field(min_length=1)


class AgendaTypeCreate(AgendaTypeDraft):
    """Schema `AgendaTypeCreate`: sem `position`, o tipo vai para o fim da lista."""

    position: int | None = Field(default=None, ge=0)


class AgendaTypePatch(BaseModel):
    """Schema `AgendaTypePatch`."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)
    title_pattern: str | None = Field(default=None, max_length=300)
    identify: str | None = None
    default_tags: list[Tag] | None = Field(default=None, max_length=20)
    summary_instructions: str | None = Field(default=None, min_length=1)
    position: int | None = Field(default=None, ge=0)


class DefaultAgendaTypeCreate(AgendaTypeCreate):
    """Schema `DefaultAgendaTypeCreate`."""

    include_for_new_users: bool = True


class DefaultAgendaTypePatch(AgendaTypePatch):
    """Schema `DefaultAgendaTypePatch`."""

    include_for_new_users: bool | None = None


def agenda_type_json(row: Row) -> dict[str, Any]:
    """Schema `AgendaType`."""
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "title_pattern": row["title_pattern"],
        "identify": row["identify"],
        "default_tags": list(row["default_tags"]),
        "summary_instructions": row["summary_instructions"],
        "position": row["position"],
    }


def default_agenda_type_json(row: Row) -> dict[str, Any]:
    """Schema `DefaultAgendaType`: o `AgendaType` com `include_for_new_users`."""
    return {**agenda_type_json(row), "include_for_new_users": row["include_for_new_users"]}


def create_values(body: AgendaTypeDraft) -> dict[str, Any]:
    """Os valores de um tipo novo, com as tags sem repetição (`position` resolvido por quem insere)."""
    values = body.model_dump()
    values["default_tags"] = list(dict.fromkeys(values["default_tags"]))
    return values


def changes_of(body: AgendaTypePatch) -> dict[str, Any]:
    """Os campos enviados; recusa corpo vazio e `null` onde o schema não aceita."""
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise invalid_field("body", "informe ao menos um campo")
    for field in (*REQUIRED, "include_for_new_users"):
        if field in values and values[field] is None:
            raise invalid_field(field, "não pode ser nulo")
    if "default_tags" in values:
        values["default_tags"] = list(dict.fromkeys(values["default_tags"]))
    return values


async def next_position(conn: AsyncConnection, table: Table) -> int:
    """Uma posição depois da última da lista (a do usuário, sob a RLS, ou a da plataforma).

    Serve às listas ordenadas pelo usuário: tipos de agenda e campos.
    """
    last = (await conn.execute(select(func.max(table.c.position)))).scalar()
    return 1 if last is None else last + 1


async def get_agenda_type(conn: AsyncConnection, agenda_type_id: UUID) -> Row:
    """Tipo do usuário da transação (a RLS só mostra os dele), ou 404."""
    row = (await conn.execute(select(t.agenda_types).where(t.agenda_types.c.id == agenda_type_id))).mappings().first()
    if row is None:
        raise not_found("Tipo de agenda inexistente ou sem acesso.")
    return row


# --- aplicar o tipo à gravação -----------------------------------------------------------------------

_MARKER = re.compile(r"\{([a-z0-9_]+)\}")
# Separadores entre as partes do título: ` · `, ` - `, ` | ` e os travessões.
_SEPARATOR = re.compile(r"(\s+[·\-|\u2013\u2014]\s+)")


def render_title(pattern: str, values: dict[str, str]) -> str:
    """O padrão com os marcadores trocados; uma parte que fica vazia sai junto com o separador dela."""
    pieces = _SEPARATOR.split(pattern)
    parts = [_MARKER.sub(lambda match: values.get(match.group(1), ""), part).strip() for part in pieces[::2]]
    separators = pieces[1::2]
    kept: list[str] = []
    for index, part in enumerate(parts):
        if not part:
            continue
        if kept:
            kept.append(separators[index - 1])
        kept.append(part)
    return "".join(kept)


async def title_values(conn: AsyncConnection, recording: Row, agenda_type: Row | dict[str, Any]) -> dict[str, str]:
    """Os marcadores do padrão: `{assunto}` é o título automático, e cada campo, o valor dele."""
    fv = t.field_values.c
    rows = (
        await conn.execute(
            select(t.fields.c.key, t.fields.c.builtin, fv.value)
            .join(t.field_values, fv.field_id == t.fields.c.id)
            .where(fv.recording_id == recording["id"])
        )
    ).all()
    values = {"data": recording["recorded_at"].strftime("%d/%m/%Y"), "tipo": agenda_type["name"]}
    subject = recording["title"]
    for key, builtin, value in rows:
        text = ", ".join(value) if isinstance(value, list) else (value or "")
        if builtin == "title":
            subject = text or subject
        elif builtin is None:
            values[key] = text
    values["assunto"] = subject
    return values


async def apply_type(conn: AsyncConnection, recording: Row, agenda_type: Row | None, origin: str | None) -> None:
    """Grava o tipo da gravação e aplica o padrão de título e as tags padrão dele.

    O título só muda se não foi escrito nem aceito pelo usuário; as tags padrão se somam às
    automáticas, e as do usuário ficam como estão. Sem tipo, só limpa o tipo.
    """
    changes: dict[str, Any] = {
        "agenda_type_id": agenda_type["id"] if agenda_type is not None else None,
        "agenda_type_origin": origin,
    }
    if agenda_type is not None:
        fv = t.field_values.c
        locked = set(
            (
                await conn.execute(
                    select(t.fields.c.builtin)
                    .join(t.field_values, fv.field_id == t.fields.c.id)
                    .where(fv.recording_id == recording["id"], fv.origin.in_(("edited", "accepted")))
                )
            ).scalars()
        )
        if agenda_type["title_pattern"] and "title" not in locked:
            title = render_title(agenda_type["title_pattern"], await title_values(conn, recording, agenda_type))
            if title:
                changes["title"] = title
        if agenda_type["default_tags"] and "tags" not in locked:
            changes["tags"] = list(dict.fromkeys([*recording["tags"], *agenda_type["default_tags"]]))
    now = func.now()
    await conn.execute(
        update(t.recordings).where(t.recordings.c.id == recording["id"]).values(**changes, updated_at=now)
    )
    await conn.execute(
        update(t.transcripts).where(t.transcripts.c.recording_id == recording["id"]).values(updated_at=now)
    )


# --- detecção (job `detect_agenda_type`) -----------------------------------------------------------


async def run_detect(ctx: dict[str, Any], recording_id: UUID, revision: int) -> str:
    """O job `detect_agenda_type`: escolhe o tipo da gravação e o aplica; grava a etapa `agenda_type`.

    Roda com o papel de conexão, no worker CPU. O tipo escolhido pelo usuário (`edited`) fica.
    """
    engine = ctx["engine"]
    async with system_tx(engine) as conn:
        recording = (
            (await conn.execute(select(t.recordings).where(t.recordings.c.id == recording_id))).mappings().first()
        )
        if recording is None:
            return GONE
        if await current_revision(conn, recording_id) != revision:
            return STALE
        skip = None
        types = (
            (
                await conn.execute(
                    select(t.agenda_types)
                    .where(t.agenda_types.c.owner_id == recording["owner_id"])
                    .order_by(t.agenda_types.c.position, t.agenda_types.c.id)
                )
            )
            .mappings()
            .all()
        )
        provider = await provider_for(conn, "agenda_detection")
        if recording["agenda_type_origin"] == "edited" and recording["agenda_type_id"] is not None:
            skip = "set_by_user"
        elif not types:
            skip = "no_types"
        elif provider is None:
            skip = "no_provider"
        if skip is not None:
            await set_step(conn, recording, revision, "agenda_type", "skipped", detail={"reason": skip})
            return f"pulada: {skip}"
        step = await get_step(conn, recording_id, revision, "agenda_type")
        started = step["started_at"] if step is not None else None
        detail = dict(step["detail"]) if step is not None else {}
        loaded = await load_provider(conn, provider["id"])
        transcript_id = (
            await conn.execute(select(t.transcripts.c.id).where(t.transcripts.c.recording_id == recording_id))
        ).scalar_one()
        transcript = await transcript_text(conn, transcript_id)
        await set_step(conn, recording, revision, "agenda_type", "active", detail=detail, started_at=started)
    specs = [TypeSpec(name=row["name"], identify=row["identify"]) for row in types]
    outcome = await call_agent_step(
        ctx,
        AgentStep(recording, revision, "agenda_type", started, detail),
        loaded,
        lambda agent: detect_type(agent, specs, transcript),
    )
    if isinstance(outcome, str):
        return outcome
    chosen = types[outcome.index]
    async with system_tx(engine) as conn:
        current = (await conn.execute(select(t.recordings).where(t.recordings.c.id == recording_id))).mappings().one()
        # O usuário pode ter escolhido um tipo enquanto o agente trabalhava: esse fica.
        if current["agenda_type_origin"] != "edited":
            await apply_type(conn, current, chosen, "auto")
        await set_step(
            conn,
            recording,
            revision,
            "agenda_type",
            "done",
            detail={
                "agenda_type_id": str(chosen["id"]),
                "agenda_type_name": chosen["name"],
                "confidence": outcome.confidence,
                "reason_text": outcome.reason,
                "model": outcome.completion.model,
            },
        )
    return f"tipo: {chosen['name']}"
