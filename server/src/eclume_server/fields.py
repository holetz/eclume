"""Campos do usuário: os embutidos (título e tags) e os próprios (texto, lista, escolha).

Cada campo tem a regra ("como identificar") que o agente segue ao preenchê-lo. Contrato e decisões
em docs/standards/code/processamento-automatico.md.
"""

from __future__ import annotations

import re
import unicodedata
from typing import TYPE_CHECKING, Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import exists, false, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from eclume_server.agenda_types import refresh_title, title_rule
from eclume_server.agents.extraction import (
    MAX_INSTRUCTIONS,
    MAX_TAG,
    MAX_TEXT,
    CollectionSpec,
    FieldSpec,
    Participant,
    RecordingContext,
    TagGuide,
    extract,
)
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.pagination import iso
from eclume_server.pipeline import GONE, STALE, current_revision, get_step, set_step
from eclume_server.problems import invalid_field, not_found
from eclume_server.summaries import (
    AgentStep,
    call_agent_step,
    load_provider,
    provider_for,
    transcript_text,
)
from eclume_server.tags import MAX_CATALOG, adopt, catalog, prefs, resolve

if TYPE_CHECKING:
    from sqlalchemy import ColumnElement
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

Kind = Literal["text", "list", "choice"]
Option = Annotated[str, Field(min_length=1, max_length=120)]
# Marcadores do padrão de título que um campo não pode encobrir.
RESERVED_KEYS = frozenset({"assunto", "data", "tipo"})
MAX_KEY = 64
# Itens de um valor de lista escrito pelo usuário.
MAX_VALUE_ITEMS = 50
# O filtro por campo da biblioteca e da busca: `<field_id>:<valor>`.
FIELD_FILTER = r"^([0-9a-fA-F-]{36}):(.+)$"


class FieldDraft(BaseModel):
    """Schema `FieldDraft`: o conteúdo de um campo, salvo ou em rascunho."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    kind: Kind
    options: list[Option] = Field(default_factory=list, max_length=50)
    instructions: str = Field(default="", max_length=MAX_INSTRUCTIONS)
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
    instructions: str | None = Field(default=None, max_length=MAX_INSTRUCTIONS)
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
        items = list(dict.fromkeys(item.strip() for item in value))
        limit = MAX_TAG if field["builtin"] == "tags" else MAX_TEXT
        if len(items) > MAX_VALUE_ITEMS or any(len(item) > limit for item in items):
            raise invalid_field("value", f"até {MAX_VALUE_ITEMS} itens de até {limit} caracteres")
        return items
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
) -> bool:
    """Grava o valor e a origem; título e tags vão também para `recordings`, que a busca lê.

    Serve às rotas (sob a RLS do dono) e ao preenchimento automático (papel de conexão). O valor
    `auto` só substitui outro `auto`: o que o usuário escreveu ou aceitou no meio-tempo fica, e a
    função devolve `False`.
    """
    if field["builtin"] == "tags" and origin != "auto" and value:
        # A tag que o usuário escreve entra no cadastro, e a gravação fica com a grafia dele.
        value = await adopt(conn, field["owner_id"], value)
    fv = t.field_values
    values = {
        "value": value,
        "origin": origin,
        "transcript_revision": transcript_revision,
        "provider_name": provider_name,
        "model": model,
        "updated_at": func.now(),
    }
    written = await conn.execute(
        pg_insert(fv)
        .values(recording_id=recording_id, field_id=field["id"], owner_id=field["owner_id"], **values)
        .on_conflict_do_update(
            index_elements=[fv.c.recording_id, fv.c.field_id],
            set_=values,
            where=(fv.c.origin == "auto") if origin == "auto" else None,
        )
        .returning(fv.c.field_id)
    )
    if written.first() is None:
        return False
    # O embutido tem o nome da coluna de `recordings` em que o valor também vive.
    column = field["builtin"]
    if column is None or value is None:
        return True
    now = func.now()
    await conn.execute(
        update(t.recordings).where(t.recordings.c.id == recording_id).values({column: value, "updated_at": now})
    )
    # Título e tags aparecem na transcrição: o `?since=` dos clientes precisa ver a mudança.
    await conn.execute(update(t.transcripts).where(t.transcripts.c.recording_id == recording_id).values(updated_at=now))
    return True


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


# --- preenchimento automático (job `fill_fields`) --------------------------------------------------

LOCKED = ("edited", "accepted")


async def eligible_fields(conn: AsyncConnection, recording_id: UUID, owner_id: UUID) -> list[Row]:
    """Campos a preencher: os de `auto_fill` cujo valor o usuário não escreveu nem aceitou."""
    fv = t.field_values.c
    locked = select(fv.field_id).where(fv.recording_id == recording_id, fv.origin.in_(LOCKED))
    query = (
        select(t.fields)
        .where(t.fields.c.owner_id == owner_id, t.fields.c.auto_fill, t.fields.c.id.not_in(locked))
        .order_by(t.fields.c.position, t.fields.c.id)
    )
    return list((await conn.execute(query)).mappings().all())


async def tag_guide(conn: AsyncConnection, owner_id: UUID) -> tuple[TagGuide, list[str]]:
    """O cadastro de tags e o modo da conta, para o agente, e os nomes cadastrados."""
    rows = await catalog(conn, owner_id)
    _, limit = await prefs(conn, owner_id)
    names = [row["name"] for row in rows]
    guide = TagGuide(tags=tuple((row["name"], row["description"]) for row in rows), allow_new=limit)
    return guide, names


def spec(row: Row, title: str | None = None) -> FieldSpec:
    """O campo como o agente o vê; o título segue a regra do assunto do tipo da gravação (`title`)."""
    return FieldSpec(
        key=row["key"],
        kind=row["kind"],
        instructions=title if row["builtin"] == "title" and title else row["instructions"],
        options=tuple(row["options"]),
        max_item=MAX_TAG if row["builtin"] == "tags" else MAX_TEXT,
    )


async def recording_context(conn: AsyncConnection, recording: Row) -> tuple[RecordingContext, list[Row]]:
    """O contexto da gravação para o agente e as coleções que ele pode escolher.

    Coleções elegíveis: as automáticas com regra, se o usuário não mexeu nas coleções da gravação.
    Participantes: as pessoas ligadas aos locutores, com os dados de cadastro.
    """
    agenda_type = None
    if recording["agenda_type_id"] is not None:
        agenda_type = (
            await conn.execute(select(t.agenda_types.c.name).where(t.agenda_types.c.id == recording["agenda_type_id"]))
        ).scalar()
    p = t.people.c
    people = (
        (
            await conn.execute(
                select(p.name, p.company, p.department, p.job_title, p.tags)
                .distinct()
                .select_from(
                    t.people.join(t.speakers, t.speakers.c.person_id == p.id).join(
                        t.transcripts, t.transcripts.c.id == t.speakers.c.transcript_id
                    )
                )
                .where(t.transcripts.c.recording_id == recording["id"])
                .order_by(p.name)
            )
        )
        .mappings()
        .all()
    )
    collections: list[Row] = []
    if recording["collections_origin"] != "edited":
        c = t.collections.c
        collections = list(
            (
                await conn.execute(
                    select(t.collections)
                    .where(c.owner_id == recording["owner_id"], c.auto_assign, func.trim(c.instructions) != "")
                    .order_by(func.lower(c.name), c.id)
                )
            )
            .mappings()
            .all()
        )
    context = RecordingContext(
        agenda_type=agenda_type,
        participants=tuple(
            Participant(row["name"], row["company"], row["department"], row["job_title"], tuple(row["tags"]))
            for row in people
        ),
        collections=tuple(CollectionSpec(row["name"], row["instructions"]) for row in collections),
    )
    return context, collections


async def apply_collections(conn: AsyncConnection, recording_id: UUID, eligible: list[Row], chosen: list[UUID]) -> int:
    """Grava as coleções que o agente escolheu entre as elegíveis; devolve quantas ficaram.

    Origem `edited` (o usuário mexeu enquanto o agente trabalhava): nada muda. Origem `auto`: as
    escolhidas substituem as automáticas de antes, e as outras ficam. Sem origem (o envio): só soma.
    """
    recording = (await conn.execute(select(t.recordings).where(t.recordings.c.id == recording_id))).mappings().first()
    if recording is None or recording["collections_origin"] == "edited":
        return 0
    current = list(recording["collection_ids"])
    automatic = {row["id"] for row in eligible}
    if recording["collections_origin"] == "auto":
        current = [c for c in current if c not in automatic]
    updated = list(dict.fromkeys([*current, *chosen]))
    origin = "auto" if chosen or recording["collections_origin"] == "auto" else None
    if updated != list(recording["collection_ids"]) or origin != recording["collections_origin"]:
        now = func.now()
        await conn.execute(
            update(t.recordings)
            .where(t.recordings.c.id == recording_id)
            .values(collection_ids=updated, collections_origin=origin, updated_at=now)
        )
        # As coleções são as pastas do desktop: a transcrição reaparece no `?since=`.
        await conn.execute(
            update(t.transcripts).where(t.transcripts.c.recording_id == recording_id).values(updated_at=now)
        )
    return len(chosen)


async def run_fill_fields(ctx: dict[str, Any], recording_id: UUID, revision: int) -> str:
    """O job `fill_fields`: preenche os campos automáticos da revisão e grava a etapa `fields`.

    Roda com o papel de conexão, no worker CPU, depois da detecção do tipo: o assunto do título segue
    a regra do tipo da gravação, e no fim (preenchida, pulada ou falha) o título é remontado pelo
    padrão do tipo. Nunca sobrescreve um valor `edited` ou `accepted`. Falha passageira volta à fila
    (`arq.Retry`); a definitiva deixa a etapa `failed`, e a cadeia segue.
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
        step = await get_step(conn, recording_id, revision, "fields")
        fields = await eligible_fields(conn, recording_id, recording["owner_id"])
        context, collections = await recording_context(conn, recording)
        wanted = bool(fields or collections)
        skip = "no_auto_fields" if not wanted else None
        provider = await provider_for(conn, "fields") if wanted else None
        if wanted and provider is None:
            skip = "no_provider"
        if skip is not None:
            await set_step(conn, recording, revision, "fields", "skipped", detail={"reason": skip})
            await refresh_title(conn, recording_id)
            return f"pulada: {skip}"
        provider_row, platform_key = await load_provider(conn, provider["id"])
        transcript_id = (
            await conn.execute(select(t.transcripts.c.id).where(t.transcripts.c.recording_id == recording_id))
        ).scalar_one()
        transcript = await transcript_text(conn, transcript_id)
        tags, catalog_names = await tag_guide(conn, recording["owner_id"])
        rule = await title_rule(conn, recording)
        started = step["started_at"] if step is not None and step["started_at"] else None
        detail = dict(step["detail"]) if step is not None else {}
        await set_step(conn, recording, revision, "fields", "active", detail=detail, started_at=started)
    outcome = await call_agent_step(
        ctx,
        AgentStep(recording, revision, "fields", started, detail),
        (provider_row, platform_key),
        lambda provider: extract(provider, [spec(row, rule) for row in fields], tags, transcript, context),
    )
    if isinstance(outcome, str):
        async with system_tx(engine) as conn:
            await refresh_title(conn, recording_id)
        return outcome
    values, completion = outcome.values, outcome.completion
    async with system_tx(engine) as conn:
        # O usuário pode ter escrito um valor enquanto o agente trabalhava: esse fica.
        still = {row["id"] for row in await eligible_fields(conn, recording_id, recording["owner_id"])}
        filled = 0
        if "tags" in values:
            # Só as tags do cadastro (ou variações delas); as novas, no modo autogerenciado e até o
            # limite, entram no cadastro com a origem `auto`.
            kept, new = resolve(
                values["tags"], catalog_names, allow_new=tags.allow_new, room=MAX_CATALOG - len(catalog_names)
            )
            if new:
                await adopt(conn, recording["owner_id"], new, origin="auto")
            values["tags"] = kept or None
        for row in fields:
            value = values.get(row["key"])
            if row["id"] not in still or (value is None and row["builtin"] == "title"):
                continue
            written = await set_value(
                conn,
                recording_id,
                row,
                value,
                "auto",
                transcript_revision=revision,
                provider_name=provider_row["name"],
                model=completion.model,
            )
            filled += written and value is not None
        chosen = [collections[index]["id"] for index in outcome.collections]
        placed = await apply_collections(conn, recording_id, collections, chosen) if collections else 0
        await refresh_title(conn, recording_id)
        await set_step(
            conn,
            recording,
            revision,
            "fields",
            "done",
            detail={"filled": filled, "collections": placed, "model": completion.model},
        )
    return f"{filled} campo(s) preenchido(s), {placed} coleção(ões)"


async def field_filters(conn: AsyncConnection, raw: list[str]) -> list[ColumnElement[bool]]:
    """Um filtro por campo (`<field_id>:<valor>`): OU entre os valores do mesmo campo.

    Título e tags são embutidos e vivem na gravação; os demais, em `field_values` (texto ou escolha
    é o valor igual; lista, um dos itens). Um campo que a conta não tem não encontra nada. Os
    predicados usam `recordings`: valem em `GET /recordings` e em `GET /search`.
    """
    wanted: dict[UUID, list[str]] = {}
    for item in raw:
        match = re.fullmatch(FIELD_FILTER, item)
        if match is None:
            raise invalid_field("field", "use <field_id>:<valor>")
        try:
            field_id = UUID(match.group(1))
        except ValueError as exc:
            raise invalid_field("field", "field_id inválido") from exc
        wanted.setdefault(field_id, []).append(match.group(2))
    builtins = dict(
        (await conn.execute(select(t.fields.c.id, t.fields.c.builtin).where(t.fields.c.id.in_(wanted)))).all()
    )
    r, fv = t.recordings.c, t.field_values.c
    filters = []
    for field_id, values in wanted.items():
        if field_id not in builtins:
            filters.append(false())
        elif builtins[field_id] == "title":
            filters.append(r.title.in_(values))
        elif builtins[field_id] == "tags":
            filters.append(r.tags.overlap(values))
        else:
            matches = [
                or_(fv.value == func.to_jsonb(value), fv.value.contains(func.jsonb_build_array(value)))
                for value in values
            ]
            filters.append(exists(select(1).where(fv.recording_id == r.id, fv.field_id == field_id, or_(*matches))))
    return filters
