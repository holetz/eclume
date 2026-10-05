"""Ferramentas do servidor MCP: as mesmas operações da API, com os escopos do token.

Nomes em inglês (convenção dos clientes MCP), descrições e erros em pt-BR. Escopo faltando,
gravação inexistente ou de outro usuário e validação voltam como erro de ferramenta
(`isError: true`) que o assistente explica ao usuário.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime  # noqa: TC003 — o SDK lê as anotações para o schema da ferramenta
from typing import TYPE_CHECKING, Annotated, Any, Literal
from uuid import UUID

from mcp.server.mcpserver import Context  # noqa: TC002 — o SDK injeta o contexto pela anotação
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from pydantic import Field
from sqlalchemy import select, text

from eclume_server.agenda_types import agenda_type_json
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.fields import builtin_fields, field_json, get_field, recording_values, set_value, validate_value
from eclume_server.markers import list_markers, marker_json
from eclume_server.operations import regenerate_summary
from eclume_server.pagination import decode_position, encode_position
from eclume_server.problems import ApiProblemError
from eclume_server.quotas import charge_agent
from eclume_server.recordings import Library, delete_recording_of, get_visible, list_library, render
from eclume_server.search import SearchFilters, search
from eclume_server.summaries import edit_current, recording_transcript, summary_json, summary_state
from eclume_server.summary_chat import open_request
from eclume_server.transcripts import load_speakers, load_transcript, speaker_json, transcript_text_window

if TYPE_CHECKING:
    from collections.abc import Iterator

    from mcp.server import MCPServer

    from eclume_server.auth import Principal
    from eclume_server.context import AppContext

READ_ONLY = ToolAnnotations(read_only_hint=True, open_world_hint=False)
WRITE = ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=False)
IDEMPOTENT = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True, open_world_hint=False)
DESTRUCTIVE = ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False)
MAX_TRANSCRIPT_CHARS = 60_000
RecordingId = Annotated[str, Field(description="Id (UUID) da gravação, de search_recordings.")]
_TAGS = text(
    "SELECT tag AS name, count(*) AS count FROM recordings, unnest(recordings.tags) AS tag GROUP BY tag ORDER BY tag"
)


def principal_of(ctx: Context) -> Principal:
    """O dono do token, que o `BearerGate` pôs no scope da requisição HTTP."""
    return ctx.request_context.request.scope["eclume.principal"]


def app_of(ctx: Context) -> AppContext:
    """O `AppContext` do app FastAPI que atende o `/mcp`."""
    return ctx.request_context.request.app.state.ctx


def need(ctx: Context, *scopes: str) -> Principal:
    """O `Principal`, ou erro de ferramenta que nomeia o escopo que falta."""
    principal = principal_of(ctx)
    missing = [scope for scope in scopes if scope not in principal.scopes]
    if missing:
        noun = "o escopo" if len(missing) == 1 else "os escopos"
        msg = f"Falta {noun} {', '.join(missing)} neste token."
        raise ToolError(msg)
    return principal


@contextmanager
def as_tool_error() -> Iterator[None]:
    """Os problemas da API (404, 409, 422) viram erro de ferramenta com a mensagem em pt-BR."""
    try:
        yield
    except ApiProblemError as problem:
        errors = problem.extra.get("errors")
        message = "; ".join(f"{e['field']}: {e['message']}" for e in errors) if errors else problem.detail
        raise ToolError(message or problem.code) from problem


def uuid_of(value: str, name: str = "recording_id") -> UUID:
    """O UUID do argumento, ou erro de ferramenta."""
    try:
        return UUID(value)
    except ValueError as exc:
        msg = f"{name} inválido: {value}"
        raise ToolError(msg) from exc


def _brief(recording: dict[str, Any]) -> dict[str, Any]:
    agenda_type = recording["agenda_type"]
    return {
        "id": recording["id"],
        "title": recording["title"],
        "recorded_at": recording["recorded_at"],
        "kind": recording["kind"],
        "status": recording["status"],
        "duration_ms": recording["duration_ms"],
        "agenda_type": agenda_type["name"] if agenda_type else None,
        "tags": recording["tags"],
    }


def _hit(hit: dict[str, Any]) -> dict[str, Any]:
    speaker = hit["speaker"]
    return {
        "recording_id": hit["transcript"]["recording_id"],
        "title": hit["transcript"]["title"],
        "recorded_at": hit["transcript"]["recorded_at"],
        "speaker": speaker["person"]["name"] if speaker["person"] else speaker["label"],
        "start_ms": hit["segment"]["start_ms"],
        "text": hit["segment"]["text"],
    }


async def _search(  # noqa: PLR0913 — os filtros da busca
    app: AppContext,
    principal: Principal,
    *,
    query: str,
    started_from: datetime | None,
    started_to: datetime | None,
    tags: list[str] | None,
    limit: int,
    cursor: str | None,
) -> dict[str, Any]:
    if tags and len(tags) > 1:
        msg = "Com query, informe no máximo uma tag."
        raise ToolError(msg)
    offset = 0
    if cursor:
        (value,) = decode_position(cursor, 1)
        offset = int(value) if value.isdigit() else 0
    filters = SearchFilters(query, None, started_from, started_to, tags[0] if tags else None, None)
    async with user_tx(app.engine, principal.user_id) as conn:
        hits = await search(conn, filters, offset, limit)
    next_cursor = encode_position(offset + limit) if len(hits) > limit else None
    return {"hits": [_hit(hit) for hit in hits[:limit]], "next_cursor": next_cursor}


def register(server: MCPServer) -> None:
    """Registra as ferramentas no servidor."""
    _read_tools(server)
    _write_tools(server)


def _read_tools(server: MCPServer) -> None:

    @server.tool(
        annotations=READ_ONLY,
        description=(
            "Busca gravações do usuário. Sem query, lista a biblioteca por data de início (mais recentes "
            "primeiro) com filtros; com query, busca o texto falado nas transcrições e devolve os trechos."
        ),
    )
    async def search_recordings(  # noqa: PLR0913, PLR0917 — os filtros da biblioteca
        ctx: Context,
        query: Annotated[str | None, Field(description="Texto a buscar nas falas (aspas para frase).")] = None,
        started_from: Annotated[datetime | None, Field(description="Início da gravação a partir de.")] = None,
        started_to: Annotated[datetime | None, Field(description="Início da gravação antes de.")] = None,
        tags: Annotated[list[str] | None, Field(description="Qualquer uma destas tags.")] = None,
        agenda_type: Annotated[list[str] | None, Field(description="Ids de tipos de agenda.")] = None,
        status: Annotated[
            list[Literal["uploading", "queued", "processing", "transcribed", "failed"]] | None,
            Field(description="Qualquer um destes estados."),
        ] = None,
        limit: Annotated[int, Field(ge=1, le=50)] = 20,
        cursor: Annotated[str | None, Field(description="next_cursor da página anterior.")] = None,
    ) -> dict[str, Any]:
        app = app_of(ctx)
        with as_tool_error():
            if query and query.strip():
                principal = need(ctx, "recordings:read", "transcripts:read")
                return await _search(
                    app,
                    principal,
                    query=query.strip(),
                    started_from=started_from,
                    started_to=started_to,
                    tags=tags,
                    limit=limit,
                    cursor=cursor,
                )
            principal = need(ctx, "recordings:read")
            types = [uuid_of(value, "agenda_type") for value in agenda_type] if agenda_type else None
            library = Library(None, started_from, started_to, None, status, tags, None, None, None, types)
            page = await list_library(app, principal.user_id, library, sort="recorded_desc", cursor=cursor, limit=limit)
        return {"recordings": [_brief(item) for item in page["items"]], "next_cursor": page["next_cursor"]}

    @server.tool(
        annotations=READ_ONLY,
        description=(
            "Uma gravação: data de início, tipo de agenda, tags, campos do usuário com a origem do valor, "
            "pessoas (locutores), marcadores e o status de cada etapa do processamento."
        ),
    )
    async def get_recording(recording_id: RecordingId, ctx: Context) -> dict[str, Any]:
        principal = need(ctx, "recordings:read")
        app = app_of(ctx)
        rid = uuid_of(recording_id)
        with as_tool_error():
            async with user_tx(app.engine, principal.user_id) as conn:
                row = await get_visible(conn, rid)
                recording = (await conn.execute(select(t.recordings).where(t.recordings.c.id == rid))).mappings().one()
                values = await recording_values(conn, recording)
                markers = [marker_json(m) for m in await list_markers(conn, rid)]
                speakers = []
                if row["transcript_id"] is not None:
                    speakers = (await load_speakers(conn, [row["transcript_id"]]))[row["transcript_id"]]
            (rendered,) = await render(app, principal.user_id, [row])
        return {
            **_brief(rendered),
            "recorded_at_source": rendered["recorded_at_source"],
            "language": rendered["language"],
            "pipeline": rendered["pipeline"],
            "fields": [
                {"field_id": v["field"]["id"], "name": v["field"]["name"], "value": v["value"], "origin": v["origin"]}
                for v in values
            ],
            "people": [
                {"speaker": s["label"], "person": s["person"]["name"] if s["person"] else None}
                for s in map(speaker_json, speakers)
            ],
            "markers": [{"at_ms": m["at_ms"], "note": m["note"], "device_name": m["device_name"]} for m in markers],
        }

    @server.tool(
        annotations=READ_ONLY,
        description=(
            "Os campos do usuário (tipo e opções), as tags em uso e os tipos de agenda, para editar "
            "gravações com valores válidos."
        ),
    )
    async def list_fields_and_tags(ctx: Context) -> dict[str, Any]:
        principal = need(ctx, "recordings:read")
        async with user_tx(app_of(ctx).engine, principal.user_id) as conn:
            fields = (await conn.execute(select(t.fields).order_by(t.fields.c.position, t.fields.c.id))).mappings()
            fields = [field_json(row) for row in fields]
            tags = (await conn.execute(_TAGS)).mappings().all()
            types = (
                await conn.execute(select(t.agenda_types).order_by(t.agenda_types.c.position, t.agenda_types.c.id))
            ).mappings()
            types = [agenda_type_json(row) for row in types]
        return {
            "fields": [
                {"id": f["id"], "name": f["name"], "kind": f["kind"], "options": f["options"], "builtin": f["builtin"]}
                for f in fields
            ],
            "tags": [{"name": row["name"], "count": row["count"]} for row in tags],
            "agenda_types": [{"id": a["id"], "name": a["name"]} for a in types],
        }

    @server.tool(
        annotations=READ_ONLY,
        description=(
            "O texto da transcrição, uma fala por linha ([mm:ss] Locutor: fala), até 60 000 caracteres por "
            "chamada; next_start_ms indica onde continuar."
        ),
    )
    async def get_transcript(
        recording_id: RecordingId,
        ctx: Context,
        start_ms: Annotated[int, Field(ge=0, description="A partir deste instante.")] = 0,
        end_ms: Annotated[int | None, Field(ge=0, description="Antes deste instante.")] = None,
    ) -> dict[str, Any]:
        principal = need(ctx, "transcripts:read")
        rid = uuid_of(recording_id)
        with as_tool_error():
            async with user_tx(app_of(ctx).engine, principal.user_id) as conn:
                transcript = await recording_transcript(conn, rid)
                document = await load_transcript(conn, transcript["id"], words=False)
        text_, next_start = transcript_text_window(document, start_ms, end_ms, MAX_TRANSCRIPT_CHARS)
        return {"recording_id": recording_id, "text": text_, "next_start_ms": next_start}

    @server.tool(
        annotations=READ_ONLY,
        description=(
            "O resumo atual da gravação em Markdown, o id e o número da versão, a origem (generated, manual "
            "ou chat) e se há uma geração em andamento."
        ),
    )
    async def get_summary(recording_id: RecordingId, ctx: Context) -> dict[str, Any]:
        principal = need(ctx, "summaries:read")
        rid = uuid_of(recording_id)
        with as_tool_error():
            async with user_tx(app_of(ctx).engine, principal.user_id) as conn:
                state = await summary_state(conn, (await recording_transcript(conn, rid))["id"])
        return summary_view(recording_id, state)


def _write_tools(server: MCPServer) -> None:
    @server.tool(
        annotations=WRITE,
        description=(
            "Grava um novo texto do resumo (Markdown) como versão manual, sobre a versão atual. As versões "
            "anteriores ficam guardadas."
        ),
    )
    async def update_summary(
        recording_id: RecordingId,
        content_md: Annotated[str, Field(min_length=1, max_length=200_000, description="O resumo inteiro.")],
        ctx: Context,
    ) -> dict[str, Any]:
        principal = need(ctx, "summaries:read", "summaries:write")
        rid = uuid_of(recording_id)
        with as_tool_error():
            async with user_tx(app_of(ctx).engine, principal.user_id) as conn:
                transcript = await recording_transcript(conn, rid)
                row = await edit_current(conn, transcript, content_md, principal.user_id)
        version = summary_json(row)
        return {"recording_id": recording_id, "version_id": version["id"], "version": version["version"]}

    @server.tool(
        annotations=WRITE,
        description=(
            "Pede um resumo novo. Sem instruction, gera pelas instruções do tipo de agenda da gravação; com "
            "instruction, manda o pedido ao agente de ajuste, que muda o resumo atual. Volta o id da versão ou "
            "da resposta pendente: consulte get_summary depois."
        ),
    )
    async def request_summary(
        recording_id: RecordingId,
        ctx: Context,
        instruction: Annotated[
            str | None, Field(max_length=4000, description="O que mudar no resumo atual (chat de ajuste).")
        ] = None,
    ) -> dict[str, Any]:
        principal = need(ctx, "summaries:read", "summaries:write")
        app = app_of(ctx)
        rid = uuid_of(recording_id)
        with as_tool_error():
            async with user_tx(app.engine, principal.user_id) as conn:
                transcript = await recording_transcript(conn, rid)
                if instruction and instruction.strip():
                    _, reply = await open_request(conn, transcript, instruction.strip(), principal.user_id)
                    await charge_agent(conn, app.queue.pool, principal.user_id)
                else:
                    # A mesma operação que o Agente usa para regenerar resumos em lote.
                    summary_id = await regenerate_summary(conn, app.queue.pool, principal.user_id, rid)
        if instruction and instruction.strip():
            await app.queue.enqueue_summary_chat(reply["id"])
            return {"recording_id": recording_id, "mode": "chat", "pending_id": str(reply["id"])}
        await app.queue.enqueue_summarize(summary_id)
        return {"recording_id": recording_id, "mode": "generate", "pending_id": str(summary_id)}

    @server.tool(
        annotations=IDEMPOTENT,
        description=(
            "Edita o título, as tags (a lista inteira) e os campos do usuário de uma gravação; o valor vira "
            "origem editado, que o preenchimento automático não sobrescreve. Use os ids e as opções de "
            "list_fields_and_tags."
        ),
    )
    async def update_fields(
        recording_id: RecordingId,
        ctx: Context,
        title: Annotated[str | None, Field(min_length=1, description="Título novo.")] = None,
        tags: Annotated[list[str] | None, Field(description="A lista inteira de tags.")] = None,
        fields: Annotated[
            dict[str, Any] | None,
            Field(description="Valores por id de campo: texto, uma das opções ou lista de textos; null limpa."),
        ] = None,
    ) -> dict[str, Any]:
        principal = need(ctx, "recordings:write")
        rid = uuid_of(recording_id)
        if title is None and tags is None and not fields:
            msg = "Informe title, tags ou fields."
            raise ToolError(msg)
        with as_tool_error():
            async with user_tx(app_of(ctx).engine, principal.user_id) as conn:
                await get_visible(conn, rid)
                builtins = await builtin_fields(conn, principal.user_id)
                changes = [(builtins["title"], title), (builtins["tags"], tags)]
                changes = [(field, value) for field, value in changes if value is not None]
                for field_id, value in (fields or {}).items():
                    changes.append((await get_field(conn, uuid_of(field_id, "field_id")), value))
                for field, value in changes:
                    await set_value(conn, rid, field, validate_value(field, value), "edited")
                recording = (await conn.execute(select(t.recordings).where(t.recordings.c.id == rid))).mappings().one()
                values = await recording_values(conn, recording)
        return {
            "recording_id": recording_id,
            "fields": [
                {"field_id": v["field"]["id"], "name": v["field"]["name"], "value": v["value"], "origin": v["origin"]}
                for v in values
            ],
        }

    @server.tool(
        annotations=DESTRUCTIVE,
        description=(
            "Exclui a gravação para sempre: áudio, transcrição, resumos, marcadores e campos. Confirme com o "
            "usuário antes."
        ),
    )
    async def delete_recording(recording_id: RecordingId, ctx: Context) -> dict[str, Any]:
        principal = need(ctx, "recordings:delete")
        with as_tool_error():
            await delete_recording_of(app_of(ctx), principal.user_id, uuid_of(recording_id))
        return {"recording_id": recording_id, "deleted": True}


def summary_view(recording_id: str, state: dict[str, Any]) -> dict[str, Any]:
    """A versão atual e a geração em aberto, do schema `SummaryState`."""
    current, pending = state["current"], state["pending"]
    return {
        "recording_id": recording_id,
        "status": "done" if current else ("pending" if pending else "missing"),
        "version_id": current["id"] if current else None,
        "version": current["version"] if current else None,
        "origin": current["origin"] if current else None,
        "content_md": current["content_md"] if current else None,
        "pending_version_id": pending["id"] if pending else None,
    }
