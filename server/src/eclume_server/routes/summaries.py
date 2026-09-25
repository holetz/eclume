"""Templates de resumo (pessoais e padrões da organização) e resumos versionados de transcrições.

Templates da organização (`owner_id` nulo) só são criados, editados e excluídos por `admin` com
sessão. Resumos herdam a visibilidade da transcrição; gerar e excluir é só do dono da gravação.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, insert, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncConnection

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.pagination import Cursor, Limit, decode_cursor, page
from eclume_server.problems import forbidden, invalid_field, not_found
from eclume_server.serialize import Row
from eclume_server.summaries import (
    create_summary,
    get_summarization,
    set_summarization,
    summary_json,
    template_json,
)

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("summaries:read"))]
Writer = Annotated[Principal, Depends(requires("summaries:write"))]


class SummaryTemplateCreate(BaseModel):
    """Schema `SummaryTemplateCreate`."""

    name: str = Field(min_length=1)
    description: str | None = None
    instructions: str = Field(min_length=1)
    is_default: bool = False
    scope: Literal["user", "organization"] = "user"


class SummaryTemplatePatch(BaseModel):
    """Schema `SummaryTemplatePatch`."""

    name: str | None = Field(default=None, min_length=1)
    description: str | None = None
    instructions: str | None = Field(default=None, min_length=1)
    is_default: bool | None = None


class SummaryCreate(BaseModel):
    """Schema `SummaryCreate`."""

    template_id: UUID
    provider_id: UUID | None = None


def _require_org_admin(principal: Principal) -> None:
    """Padrões da organização: só `admin`, e só com sessão (um PAT vazado não muda a organização)."""
    if principal.method != "session" or not principal.is_admin:
        raise forbidden("Templates da organização só são alterados por admin, com sessão do navegador.")


async def _template(conn: AsyncConnection, template_id: UUID) -> Row:
    row = (
        (await conn.execute(select(t.summary_templates).where(t.summary_templates.c.id == template_id)))
        .mappings()
        .first()
    )
    if row is None:
        raise not_found("Template inexistente ou sem acesso.")
    return row


async def _org_default(conn: AsyncConnection, org_id: UUID) -> str | None:
    return (await get_summarization(conn, org_id)).get("default_template_id")


async def _clear_personal_default(conn: AsyncConnection, user_id: UUID) -> None:
    await conn.execute(
        update(t.summary_templates)
        .where(t.summary_templates.c.owner_id == user_id, t.summary_templates.c.is_default)
        .values(is_default=False, updated_at=func.now())
    )


# --- templates ----------------------------------------------------------------------------------


@router.get("/summary-templates")
async def list_summary_templates(
    principal: Reader, ctx: Ctx, cursor: Cursor = None, limit: Limit = 50
) -> dict[str, Any]:
    """Padrões da organização e templates do usuário, na ordem de criação."""
    c = t.summary_templates.c
    query = select(t.summary_templates).order_by(c.created_at, c.id).limit(limit + 1)
    if cursor:
        query = query.where(tuple_(c.created_at, c.id) > decode_cursor(cursor))
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        rows = list((await conn.execute(query)).mappings().all())
        default = await _org_default(conn, principal.org_id)
    return page([template_json(row, default) for row in rows], rows, limit, "created_at")


@router.post("/summary-templates", status_code=201)
async def create_summary_template(body: SummaryTemplateCreate, principal: Writer, ctx: Ctx) -> dict[str, Any]:
    """Cria um template pessoal, ou um padrão da organização (`scope: organization`, admin)."""
    organization = body.scope == "organization"
    if organization:
        _require_org_admin(principal)
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        if body.is_default and not organization:
            await _clear_personal_default(conn, principal.user_id)
        row = (
            (
                await conn.execute(
                    insert(t.summary_templates)
                    .values(
                        org_id=principal.org_id,
                        owner_id=None if organization else principal.user_id,
                        name=body.name,
                        description=body.description,
                        instructions=body.instructions,
                        is_default=body.is_default and not organization,
                    )
                    .returning(t.summary_templates)
                )
            )
            .mappings()
            .one()
        )
        if organization and body.is_default:
            await set_summarization(conn, principal.org_id, principal.user_id, default_template_id=str(row["id"]))
        default = await _org_default(conn, principal.org_id)
    return template_json(row, default)


@router.get("/summary-templates/{template_id}")
async def get_summary_template(template_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Um template visível ao usuário."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        row = await _template(conn, template_id)
        default = await _org_default(conn, principal.org_id)
    return template_json(row, default)


@router.patch("/summary-templates/{template_id}")
async def update_summary_template(
    template_id: UUID, body: SummaryTemplatePatch, principal: Writer, ctx: Ctx
) -> dict[str, Any]:
    """Edita um template; `is_default` pessoal desmarca o anterior, o da organização muda o padrão dela."""
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise invalid_field("body", "informe ao menos um campo")
    for field in ("name", "instructions", "is_default"):
        if field in values and values[field] is None:
            raise invalid_field(field, "não pode ser nulo")
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        current = await _template(conn, template_id)
        organization = current["owner_id"] is None
        if organization:
            _require_org_admin(principal)
        is_default = values.pop("is_default", None)
        if is_default is not None and organization:
            default = await _org_default(conn, principal.org_id)
            if is_default:
                await set_summarization(conn, principal.org_id, principal.user_id, default_template_id=str(template_id))
            elif default == str(template_id):
                await set_summarization(conn, principal.org_id, principal.user_id, default_template_id=None)
        elif is_default is not None:
            if is_default:
                await _clear_personal_default(conn, principal.user_id)
            values["is_default"] = is_default
        row = (
            (
                await conn.execute(
                    update(t.summary_templates)
                    .where(t.summary_templates.c.id == template_id)
                    .values(**values, updated_at=func.now())
                    .returning(t.summary_templates)
                )
            )
            .mappings()
            .one()
        )
        default = await _org_default(conn, principal.org_id)
    return template_json(row, default)


@router.delete("/summary-templates/{template_id}", status_code=204)
async def delete_summary_template(template_id: UUID, principal: Writer, ctx: Ctx) -> Response:
    """Exclui o template; resumos já gerados ficam (guardam nome e instruções)."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        current = await _template(conn, template_id)
        if current["owner_id"] is None:
            _require_org_admin(principal)
            if await _org_default(conn, principal.org_id) == str(template_id):
                await set_summarization(conn, principal.org_id, principal.user_id, default_template_id=None)
        await conn.execute(delete(t.summary_templates).where(t.summary_templates.c.id == template_id))
    return Response(status_code=204)


# --- resumos ------------------------------------------------------------------------------------


async def _transcript(conn: AsyncConnection, transcript_id: UUID) -> Row:
    """Transcrição visível, com o dono da gravação."""
    row = (
        (
            await conn.execute(
                select(t.transcripts, t.recordings.c.owner_id)
                .join(t.recordings, t.recordings.c.id == t.transcripts.c.recording_id)
                .where(t.transcripts.c.id == transcript_id)
            )
        )
        .mappings()
        .first()
    )
    if row is None:
        raise not_found("Transcrição inexistente ou sem acesso.")
    return row


async def _provider(conn: AsyncConnection, org_id: UUID, provider_id: UUID | None) -> Row:
    """O provider pedido, ou o padrão da organização; ausente ou desabilitado → 422."""
    field = "provider_id"
    if provider_id is None:
        default = (await get_summarization(conn, org_id)).get("default_provider_id")
        if default is None:
            raise invalid_field(field, "a organização não tem provider padrão; informe provider_id")
        provider_id = UUID(default)
    row = (
        (await conn.execute(select(t.agent_providers).where(t.agent_providers.c.id == provider_id))).mappings().first()
    )
    if row is None:
        raise invalid_field(field, "provider inexistente")
    if not row["enabled"]:
        raise invalid_field(field, "provider desabilitado")
    return row


async def _summary(conn: AsyncConnection, summary_id: UUID) -> Row:
    row = (await conn.execute(select(t.summaries).where(t.summaries.c.id == summary_id))).mappings().first()
    if row is None:
        raise not_found("Resumo inexistente ou sem acesso.")
    return row


@router.get("/transcripts/{transcript_id}/summaries")
async def list_summaries(
    transcript_id: UUID, principal: Reader, ctx: Ctx, cursor: Cursor = None, limit: Limit = 50
) -> dict[str, Any]:
    """Resumos da transcrição, do mais novo para o mais antigo."""
    c = t.summaries.c
    query = (
        select(t.summaries)
        .where(c.transcript_id == transcript_id)
        .order_by(c.created_at.desc(), c.id.desc())
        .limit(limit + 1)
    )
    if cursor:
        query = query.where(tuple_(c.created_at, c.id) < decode_cursor(cursor))
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        await _transcript(conn, transcript_id)
        rows = list((await conn.execute(query)).mappings().all())
    return page([summary_json(row) for row in rows], rows, limit, "created_at")


@router.post("/transcripts/{transcript_id}/summaries", status_code=202)
async def create_transcript_summary(
    transcript_id: UUID, body: SummaryCreate, principal: Writer, ctx: Ctx
) -> dict[str, Any]:
    """Gera uma nova versão do resumo daquele template, na fila do worker CPU."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        transcript = await _transcript(conn, transcript_id)
        if transcript["owner_id"] != principal.user_id:
            raise forbidden("Só o dono da gravação gera resumos dela.")
        template = (
            (await conn.execute(select(t.summary_templates).where(t.summary_templates.c.id == body.template_id)))
            .mappings()
            .first()
        )
        if template is None:
            raise invalid_field("template_id", "template inexistente ou sem acesso")
        provider = await _provider(conn, principal.org_id, body.provider_id)
        row = await create_summary(
            conn,
            transcript=transcript,
            template=template,
            provider=provider,
            trigger="manual",
            created_by=principal.user_id,
        )
    await ctx.queue.enqueue_summarize(row["id"])
    return summary_json(row)


@router.get("/summaries/{summary_id}")
async def get_summary(summary_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Um resumo (o cliente consulta até `done` ou `failed`)."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        return summary_json(await _summary(conn, summary_id))


@router.delete("/summaries/{summary_id}", status_code=204)
async def delete_summary(summary_id: UUID, principal: Writer, ctx: Ctx) -> Response:
    """Exclui uma versão; um job ainda na fila encontra o resumo apagado e não faz nada."""
    async with user_tx(ctx.engine, principal.org_id, principal.user_id) as conn:
        summary = await _summary(conn, summary_id)
        transcript = await _transcript(conn, summary["transcript_id"])
        if transcript["owner_id"] != principal.user_id:
            raise forbidden("Só o dono da gravação exclui resumos dela.")
        await conn.execute(delete(t.summaries).where(t.summaries.c.id == summary_id))
    return Response(status_code=204)
