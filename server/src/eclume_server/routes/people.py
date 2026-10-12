"""Pessoas do usuário: diretório, cadastro e as transcrições em que cada uma fala."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, exists, insert, tuple_, update
from sqlalchemy.exc import IntegrityError

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.pagination import Cursor, Limit, decode_cursor, decode_named_position, encode_position, page
from eclume_server.people import (
    MAX_PERSON_TAG,
    MAX_PERSON_TAGS,
    clean_attribute,
    clean_tags,
    facets,
    get_person,
    person_json,
    person_select,
    prefix_filter,
)
from eclume_server.problems import conflict, invalid_field, not_found
from eclume_server.routes.auth import check_email
from eclume_server.transcripts import load_speakers, summary_json, transcript_select

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("people:read"))]
Writer = Annotated[Principal, Depends(requires("people:write"))]
TranscriptReader = Annotated[Principal, Depends(requires("people:read", "transcripts:read"))]
EMAIL_TAKEN = "Já existe uma pessoa sua com este e-mail."


PersonTag = Annotated[str, Field(min_length=1, max_length=MAX_PERSON_TAG)]
MAX_PERSON_NAME = 200
Attribute = Annotated[str | None, Field(max_length=120)]


def _optional_email(value: str | None) -> str | None:
    return None if value is None else check_email(value)


def _clean_tags(value: list[str] | None) -> list[str] | None:
    return None if value is None else clean_tags(value)


class PersonCreate(BaseModel):
    """Schema `PersonCreate`."""

    name: str = Field(min_length=1, max_length=MAX_PERSON_NAME)
    email: str | None = None
    notes: str | None = None
    company: Attribute = None
    department: Attribute = None
    job_title: Attribute = None
    phone: str | None = Field(default=None, max_length=40)
    tags: list[PersonTag] = Field(default_factory=list, max_length=MAX_PERSON_TAGS)

    _email = field_validator("email")(_optional_email)
    _attributes = field_validator("company", "department", "job_title", "phone")(clean_attribute)
    _tags = field_validator("tags")(_clean_tags)


class PersonPatch(BaseModel):
    """Schema `PersonPatch`."""

    name: str | None = Field(default=None, min_length=1, max_length=MAX_PERSON_NAME)
    email: str | None = None
    notes: str | None = None
    company: Attribute = None
    department: Attribute = None
    job_title: Attribute = None
    phone: str | None = Field(default=None, max_length=40)
    tags: list[PersonTag] | None = Field(default=None, max_length=MAX_PERSON_TAGS)

    _email = field_validator("email")(_optional_email)
    _attributes = field_validator("company", "department", "job_title", "phone")(clean_attribute)
    _tags = field_validator("tags")(_clean_tags)


@router.get("/people")
async def list_people(
    principal: Reader, ctx: Ctx, cursor: Cursor = None, limit: Limit = 50, q: str | None = None
) -> dict[str, Any]:
    """Pessoas em ordem alfabética (sem acento); `q` filtra por prefixo de nome ou e-mail."""
    c = t.people.c
    query = person_select().order_by(c.sort_name, c.id).limit(limit + 1)
    if q and q.strip():
        query = query.where(prefix_filter(q))
    if cursor:
        position = decode_named_position(cursor)
        query = query.where(tuple_(c.sort_name, c.id) > position)
    async with user_tx(ctx.engine, principal.user_id) as conn:
        rows = (await conn.execute(query)).mappings().all()
    next_cursor = encode_position(rows[limit - 1]["sort_name"], rows[limit - 1]["id"]) if len(rows) > limit else None
    return {"items": [person_json(row) for row in rows[:limit]], "next_cursor": next_cursor}


@router.get("/people/facets")
async def list_person_facets(principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Empresas, áreas e tags de pessoa em uso, com quantas pessoas usam cada uma."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await facets(conn)


@router.post("/people", status_code=201)
async def create_person(body: PersonCreate, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Cadastra uma pessoa; e-mail repetido entre as pessoas do usuário é 409."""
    try:
        async with user_tx(ctx.engine, principal.user_id) as conn:
            person_id = (
                await conn.execute(
                    insert(t.people)
                    .values(owner_id=principal.user_id, created_by=principal.user_id, **body.model_dump())
                    .returning(t.people.c.id)
                )
            ).scalar_one()
            row = await get_person(conn, person_id)
    except IntegrityError as exc:
        raise conflict(EMAIL_TAKEN) from exc
    return person_json(row)


@router.get("/people/{person_id}")
async def read_person(person_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Uma pessoa."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return person_json(await get_person(conn, person_id))


@router.patch("/people/{person_id}")
async def update_person(person_id: UUID, body: PersonPatch, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Edita nome, e-mail, notas e atributos; renomear sobe o `updated_at` das transcrições em que ela fala."""
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise invalid_field("body", "informe ao menos um campo")
    for field in ("name", "tags"):
        if field in values and values[field] is None:
            raise invalid_field(field, "não pode ser nulo")
    try:
        async with user_tx(ctx.engine, principal.user_id) as conn:
            await get_person(conn, person_id)
            await conn.execute(
                update(t.people).where(t.people.c.id == person_id).values(**values, updated_at=datetime.now(UTC))
            )
            row = await get_person(conn, person_id)
    except IntegrityError as exc:
        # O contrato não declara 409 no PATCH: e-mail repetido é um campo inválido.
        raise invalid_field("email", EMAIL_TAKEN) from exc
    return person_json(row)


@router.delete("/people/{person_id}", status_code=204)
async def delete_person(person_id: UUID, principal: Writer, ctx: Ctx) -> Response:
    """Exclui a pessoa; os locutores ligados a ela ficam sem pessoa e mantêm o `label`."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        result = await conn.execute(delete(t.people).where(t.people.c.id == person_id))
    if result.rowcount == 0:
        raise not_found("Pessoa inexistente ou sem acesso.")
    return Response(status_code=204)


@router.get("/people/{person_id}/transcripts")
async def list_person_transcripts(
    person_id: UUID, principal: TranscriptReader, ctx: Ctx, cursor: Cursor = None, limit: Limit = 50
) -> dict[str, Any]:
    """Transcrições do usuário em que a pessoa fala, da gravação mais recente para a mais antiga."""
    tc = t.transcripts.c
    recorded_at = t.recordings.c.recorded_at
    query = (
        transcript_select()
        .where(exists().where(t.speakers.c.transcript_id == tc.id, t.speakers.c.person_id == person_id))
        .order_by(recorded_at.desc(), tc.id.desc())
        .limit(limit + 1)
    )
    if cursor:
        query = query.where(tuple_(recorded_at, tc.id) < decode_cursor(cursor))
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await get_person(conn, person_id)
        rows = list((await conn.execute(query)).mappings().all())
        speakers = await load_speakers(conn, [row["id"] for row in rows[:limit]])
    items = [summary_json(row, speakers.get(row["id"], [])) for row in rows]
    return page(items, rows, limit, "recorded_at")
