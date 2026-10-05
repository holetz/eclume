"""O Agente: conversas persistidas, anexos, perguntas com resposta assíncrona e arquivos para baixar.

Tudo sob a RLS do dono: a conversa, a mensagem ou o arquivo de outra conta é 404. As rotas pedem
`summaries:read`, como `/base-chat`; ler transcrições continua sendo das ferramentas (sessão e
credencial de aparelho sim, PAT só com `transcripts:read`). Contrato em
docs/standards/code/server-agentes.md §Agente.

As ações propostas pelo agente (holetz/eclume#145) se confirmam ou descartam aqui; confirmar exige
o escopo de escrita da ferramenta (`summaries:write` ou `recordings:write`) e é idempotente.
"""

from __future__ import annotations

import unicodedata
from typing import Annotated, Any
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, File, Response, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from eclume_server.agent_actions import cancel_action, confirm_action, enqueue_action, list_actions, read_action
from eclume_server.agent_files import MAX_INPUT_BYTES, MAX_INPUTS_PER_MESSAGE
from eclume_server.agent_sessions import (
    MAX_MESSAGE,
    MAX_TITLE,
    add_input_file,
    create_session,
    delete_input_file,
    delete_session,
    enqueue_turn,
    file_for_download,
    list_sessions,
    read_message,
    rename_session,
    send_message,
    session_detail,
)
from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db.session import user_tx
from eclume_server.pagination import Cursor, Limit
from eclume_server.problems import payload_too_large
from eclume_server.quotas import agent_limit, take_agent_request

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("summaries:read"))]


class AgentSessionCreate(BaseModel):
    """Schema `AgentSessionCreate`: o título é opcional (a primeira pergunta dá um)."""

    title: str = Field(default="", max_length=MAX_TITLE)


class AgentSessionUpdate(BaseModel):
    """Schema `AgentSessionUpdate`."""

    title: str = Field(min_length=1, max_length=MAX_TITLE)


class AgentMessageCreate(BaseModel):
    """Schema `AgentMessageCreate`: a pergunta e os anexos ainda não enviados desta conversa."""

    message: str = Field(min_length=1, max_length=MAX_MESSAGE)
    attachments: list[UUID] = Field(default_factory=list, max_length=MAX_INPUTS_PER_MESSAGE)
    # O nome da habilidade escolhida no seletor; `/nome` no começo da mensagem vale o mesmo.
    skill: str | None = Field(default=None, max_length=41)


WRITE_SCOPES = ("summaries:write", "recordings:write")


def _write_scopes(principal: Principal) -> frozenset[str]:
    # A sessão propõe todas as ações; um PAT, só as dos escopos de escrita dele.
    if principal.method != "pat":
        return frozenset(WRITE_SCOPES)
    return frozenset(scope for scope in WRITE_SCOPES if scope in principal.scopes)


def _transcripts(principal: Principal) -> bool:
    # Sessão e credencial de aparelho leem transcrições; um PAT, só com `transcripts:read`.
    return principal.method != "pat" or "transcripts:read" in principal.scopes


@router.get("/agent/sessions")
async def get_sessions(principal: Reader, ctx: Ctx, limit: Limit = 50, cursor: Cursor = None) -> dict[str, Any]:
    """As conversas da conta, da última atividade para trás."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await list_sessions(conn, cursor, limit)


@router.post("/agent/sessions", status_code=201)
async def post_session(principal: Reader, ctx: Ctx, body: AgentSessionCreate | None = None) -> dict[str, Any]:
    """Abre uma conversa."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await create_session(conn, principal.user_id, (body or AgentSessionCreate()).title)


@router.get("/agent/sessions/{session_id}")
async def get_session(session_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """A conversa com as mensagens, os arquivos e os anexos ainda não enviados."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await session_detail(conn, session_id)


@router.patch("/agent/sessions/{session_id}")
async def patch_session(session_id: UUID, body: AgentSessionUpdate, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Renomeia a conversa."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await rename_session(conn, session_id, body.title)


@router.delete("/agent/sessions/{session_id}", status_code=204)
async def remove_session(session_id: UUID, principal: Reader, ctx: Ctx) -> Response:
    """Exclui a conversa, as mensagens e os arquivos (o bucket é limpo pela fila de exclusão)."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await delete_session(conn, session_id)
    return Response(status_code=204)


@router.post("/agent/sessions/{session_id}/files", status_code=201)
async def post_file(
    session_id: UUID,
    principal: Reader,
    ctx: Ctx,
    file: Annotated[UploadFile, File(description="O anexo: .txt, .md, .csv, .pdf ou .docx, até 10 MB.")],
) -> dict[str, Any]:
    """Anexa um arquivo à conversa e extrai o texto dele; vai com a próxima pergunta."""
    data = await file.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise payload_too_large(MAX_INPUT_BYTES)
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await add_input_file(conn, ctx.storage, principal.user_id, session_id, file.filename or "", data)


@router.delete("/agent/sessions/{session_id}/files/{file_id}", status_code=204)
async def remove_file(session_id: UUID, file_id: UUID, principal: Reader, ctx: Ctx) -> Response:
    """Tira um anexo que ainda não foi com uma pergunta."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await delete_input_file(conn, session_id, file_id)
    return Response(status_code=204)


@router.post("/agent/sessions/{session_id}/messages", status_code=202)
async def post_message(session_id: UUID, body: AgentMessageCreate, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Grava a pergunta e enfileira a resposta; o cliente consulta a resposta até `done` ou `failed`."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        quota = await agent_limit(conn, principal.user_id)
    await take_agent_request(ctx.queue.pool, principal.user_id, quota)
    async with user_tx(ctx.engine, principal.user_id) as conn:
        turn = await send_message(conn, principal.user_id, session_id, body.message, body.attachments, skill=body.skill)
    await enqueue_turn(
        ctx.queue.pool, turn.answer_id, transcripts=_transcripts(principal), scopes=_write_scopes(principal)
    )
    return {"question": turn.question, "answer": turn.answer}


@router.get("/agent/sessions/{session_id}/messages/{message_id}")
async def get_message(session_id: UUID, message_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Uma mensagem da conversa (a resposta, até `done` ou `failed`)."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await read_message(conn, session_id, message_id)


def _disposition(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().replace('"', "") or "arquivo"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name, safe='')}"


@router.get(
    "/agent/files/{file_id}/content",
    response_class=StreamingResponse,
    responses={200: {"content": {"application/octet-stream": {}}}},
)
async def download_file(file_id: UUID, principal: Reader, ctx: Ctx) -> StreamingResponse:
    """O conteúdo de um anexo ou de um arquivo gerado, para baixar."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        row = await file_for_download(conn, file_id)
    obj = await ctx.storage.open_range(row["storage_key"], None)
    headers = {
        "Content-Disposition": _disposition(row["name"]),
        "Content-Length": str(obj.content_length),
        "X-Content-Type-Options": "nosniff",
    }
    return StreamingResponse(obj.chunks, media_type=row["media_type"], headers=headers)


@router.get("/agent/actions")
async def get_actions(principal: Reader, ctx: Ctx, limit: Limit = 50, cursor: Cursor = None) -> dict[str, Any]:
    """O registro das ações propostas pelo Agente, da mais recente para trás."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await list_actions(conn, cursor, limit)


@router.get("/agent/actions/{action_id}")
async def get_action(action_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Uma ação, com o resultado por alvo (a consulta até `done` ou `failed`)."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await read_action(conn, action_id)


@router.post("/agent/actions/{action_id}/confirm", status_code=202)
async def post_confirm(action_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Confirma a proposta e enfileira a execução; confirmar de novo devolve o estado sem repetir."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        action, enqueue = await confirm_action(conn, principal, action_id)
    if enqueue:
        await enqueue_action(ctx.queue.pool, action_id)
    return action


@router.post("/agent/actions/{action_id}/cancel")
async def post_cancel(action_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Descarta a proposta ainda não confirmada."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await cancel_action(conn, action_id)
