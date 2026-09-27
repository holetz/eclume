"""Tipos de agenda: os do usuário (`agenda_types`) e os padrão da plataforma (`default_agenda_types`).

O tipo diz como reconhecer a gravação, que título e tags ela ganha e como resumi-la. Contrato e
decisões em docs/standards/code/processamento-automatico.md.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from eclume_server.db import tables as t
from eclume_server.problems import invalid_field, not_found

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


def create_values(body: AgendaTypeCreate) -> dict[str, Any]:
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
