"""Campos do usuário: os embutidos (título e tags) e os próprios (texto, lista, escolha).

Cada campo tem a regra ("como identificar") que o agente segue ao preenchê-lo. Contrato e decisões
em docs/standards/code/processamento-automatico.md.
"""

from __future__ import annotations

import re
import unicodedata
from typing import TYPE_CHECKING, Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from eclume_server.db import tables as t
from eclume_server.pagination import iso
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


# --- valores por gravação ------------------------------------------------------------------------

MAX_TEXT = 300


def validate_value(field: Row, value: Any) -> Any:  # noqa: ANN401 — o formato depende do tipo do campo
    """O valor no formato do tipo do campo, ou 422 em `value`; `null` limpa (menos o título)."""
    kind = field["kind"]
    if value is None:
        if field["builtin"] == "title":
            raise invalid_field("value", "o título não pode ficar vazio")
        return [] if field["builtin"] == "tags" else None
    if kind == "list":
        if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
            raise invalid_field("value", "uma lista de textos não vazios")
        return list(dict.fromkeys(item.strip() for item in value))
    if not isinstance(value, str) or not value.strip():
        raise invalid_field("value", "um texto não vazio")
    value = value.strip()
    if len(value) > MAX_TEXT:
        raise invalid_field("value", f"até {MAX_TEXT} caracteres")
    if kind == "choice" and value not in field["options"]:
        raise invalid_field("value", "precisa ser uma das opções do campo")
    return value


async def set_value(  # noqa: PLR0913 — o valor, a origem e o instantâneo de quem preencheu
    conn: AsyncConnection,
    recording_id: UUID,
    field: Row,
    value: Any,  # noqa: ANN401
    origin: str,
    *,
    transcript_revision: int | None = None,
    provider_name: str | None = None,
    model: str | None = None,
) -> None:
    """Grava o valor e a origem; título e tags vão também para `recordings`, que a busca lê.

    Serve às rotas (sob a RLS do dono) e ao preenchimento automático (papel de conexão).
    """
    fv = t.field_values
    values = {
        "value": value,
        "origin": origin,
        "transcript_revision": transcript_revision,
        "provider_name": provider_name,
        "model": model,
        "updated_at": func.now(),
    }
    await conn.execute(
        pg_insert(fv)
        .values(recording_id=recording_id, field_id=field["id"], owner_id=field["owner_id"], **values)
        .on_conflict_do_update(index_elements=[fv.c.recording_id, fv.c.field_id], set_=values)
    )
    # O embutido tem o nome da coluna de `recordings` em que o valor também vive.
    column = field["builtin"]
    if column is None or value is None:
        return
    now = func.now()
    await conn.execute(
        update(t.recordings).where(t.recordings.c.id == recording_id).values({column: value, "updated_at": now})
    )
    # Título e tags aparecem na transcrição: o `?since=` dos clientes precisa ver a mudança.
    await conn.execute(update(t.transcripts).where(t.transcripts.c.recording_id == recording_id).values(updated_at=now))


async def builtin_fields(conn: AsyncConnection, owner_id: UUID) -> dict[str, Row]:
    """Os campos embutidos da conta, por `builtin` (`title`, `tags`)."""
    rows = (
        (await conn.execute(select(t.fields).where(t.fields.c.owner_id == owner_id, t.fields.c.builtin.is_not(None))))
        .mappings()
        .all()
    )
    return {row["builtin"]: row for row in rows}


async def mark_edited(conn: AsyncConnection, recording_id: UUID, owner_id: UUID, changes: dict[str, Any]) -> None:
    """Título e tags que o usuário escreveu (edição ou upload) viram origem `edited`."""
    builtins = await builtin_fields(conn, owner_id)
    for builtin in ("title", "tags"):
        if builtin in changes and builtin in builtins:
            await set_value(conn, recording_id, builtins[builtin], changes[builtin], "edited")


async def recording_values(conn: AsyncConnection, recording: Row) -> list[dict[str, Any]]:
    """Schema `RecordingFieldValue` de cada campo do usuário, com os sem valor (`value`/`origin` nulos)."""
    fv = t.field_values
    rows = (
        (
            await conn.execute(
                select(t.fields, fv.c.value, fv.c.origin, fv.c.updated_at.label("value_updated_at"))
                .outerjoin(fv, (fv.c.field_id == t.fields.c.id) & (fv.c.recording_id == recording["id"]))
                .order_by(t.fields.c.position, t.fields.c.id)
            )
        )
        .mappings()
        .all()
    )
    items = []
    for row in rows:
        value = row["value"]
        if row["builtin"] == "title":
            value = recording["title"]
        elif row["builtin"] == "tags":
            value = list(recording["tags"])
        items.append(
            {
                "field": field_json(row),
                "value": value,
                "origin": row["origin"],
                "updated_at": iso(row["value_updated_at"]),
            }
        )
    return items
