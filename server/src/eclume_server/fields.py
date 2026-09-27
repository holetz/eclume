"""Campos do usuário: os embutidos (título e tags) e os próprios (texto, lista, escolha).

Cada campo tem a regra ("como identificar") que o agente segue ao preenchê-lo. Contrato e decisões
em docs/standards/code/processamento-automatico.md.
"""

from __future__ import annotations

import re
import unicodedata
from typing import TYPE_CHECKING, Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from eclume_server.db import tables as t
from eclume_server.problems import invalid_field, not_found

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

Kind = Literal["text", "list", "choice"]
Option = Annotated[str, Field(min_length=1, max_length=120)]
# Marcadores do padrão de título que um campo não pode encobrir.
RESERVED_KEYS = frozenset({"assunto", "data", "tipo"})
MAX_KEY = 64


class FieldDraft(BaseModel):
    """Schema `FieldDraft`: o conteúdo de um campo, salvo ou em rascunho."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    kind: Kind
    options: list[Option] = Field(default_factory=list, max_length=50)
    instructions: str = ""
    auto_fill: bool = True


class FieldCreate(FieldDraft):
    """Schema `FieldCreate`: sem `position`, o campo vai para o fim da lista."""

    position: int | None = Field(default=None, ge=0)


class FieldPatch(BaseModel):
    """Schema `FieldPatch`."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)
    kind: Kind | None = None
    options: list[Option] | None = Field(default=None, max_length=50)
    instructions: str | None = None
    auto_fill: bool | None = None
    position: int | None = Field(default=None, ge=0)


def field_json(row: Row) -> dict[str, Any]:
    """Schema `Field`."""
    return {
        "id": str(row["id"]),
        "key": row["key"],
        "name": row["name"],
        "kind": row["kind"],
        "builtin": row["builtin"],
        "options": list(row["options"]),
        "instructions": row["instructions"],
        "auto_fill": row["auto_fill"],
        "position": row["position"],
    }


def slug(name: str) -> str:
    """Chave do campo a partir do nome: minúsculas, sem acento, `_` no lugar do resto."""
    plain = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "_", plain).strip("_")[:MAX_KEY] or "campo"


async def free_key(conn: AsyncConnection, name: str) -> str:
    """Uma chave livre entre os campos do usuário (sufixo `_2`, `_3`… quando já usada)."""
    base = slug(name)
    taken = set((await conn.execute(select(t.fields.c.key))).scalars()) | RESERVED_KEYS
    key, n = base, 1
    while key in taken:
        n += 1
        key = f"{base[: MAX_KEY - len(str(n)) - 1]}_{n}"
    return key


def check_options(kind: str, options: list[str]) -> list[str]:
    """Opções sem repetição; escolha exige ao menos uma, e os outros tipos não têm opções."""
    unique = list(dict.fromkeys(options))
    if kind == "choice" and not unique:
        raise invalid_field("options", "um campo de escolha precisa de ao menos uma opção")
    if kind != "choice" and unique:
        raise invalid_field("options", "só campos de escolha têm opções")
    return unique


async def get_field(conn: AsyncConnection, field_id: UUID) -> Row:
    """Campo do usuário da transação (a RLS só mostra os dele), ou 404."""
    row = (await conn.execute(select(t.fields).where(t.fields.c.id == field_id))).mappings().first()
    if row is None:
        raise not_found("Campo inexistente ou sem acesso.")
    return row
