"""Chat de ajuste do resumo: pedir, listar a conversa e consultar a resposta até `done`.

Tudo é do dono: a RLS mostra só as gravações e as mensagens da conta.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select, tuple_

from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.pagination import Cursor, Limit, decode_cursor, page
from eclume_server.problems import not_found
from eclume_server.quotas import charge_agent
from eclume_server.summaries import recording_transcript
from eclume_server.summary_chat import abandon_reply, chat_message_json, open_request

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("summaries:read"))]
Writer = Annotated[Principal, Depends(requires("summaries:write"))]


class SummaryChatRequest(BaseModel):
    """Schema `SummaryChatRequest`."""

    message: str = Field(min_length=1, max_length=4000)


@router.post("/recordings/{recording_id}/summary/chat", status_code=202)
async def send_summary_chat(
    recording_id: UUID, body: SummaryChatRequest, principal: Writer, ctx: Ctx
) -> dict[str, Any]:
    """Grava o pedido e a resposta em aberto e enfileira o `summary_chat` no worker CPU."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        transcript = await recording_transcript(conn, recording_id)
        request, reply = await open_request(conn, transcript, body.message, principal.user_id)
        await charge_agent(conn, ctx.queue.pool, principal.user_id)
    try:
        await ctx.queue.enqueue_summary_chat(reply["id"])
    except Exception:
        await abandon_reply(ctx.engine, reply["id"])
        raise
    return {"message": chat_message_json(request), "reply": chat_message_json(reply)}


@router.get("/recordings/{recording_id}/summary/chat")
async def list_summary_chat(
    recording_id: UUID, principal: Reader, ctx: Ctx, cursor: Cursor = None, limit: Limit = 50
) -> dict[str, Any]:
    """As mensagens do chat da gravação, em ordem cronológica."""
    m = t.summary_chat_messages.c
    query = (
        select(t.summary_chat_messages)
        .where(m.recording_id == recording_id)
        .order_by(m.created_at, m.id)
        .limit(limit + 1)
    )
    if cursor:
        query = query.where(tuple_(m.created_at, m.id) > decode_cursor(cursor))
    async with user_tx(ctx.engine, principal.user_id) as conn:
        if (await conn.execute(select(t.recordings.c.id).where(t.recordings.c.id == recording_id))).first() is None:
            raise not_found("Gravação inexistente ou sem acesso.")
        rows = list((await conn.execute(query)).mappings().all())
    return page([chat_message_json(row) for row in rows], rows, limit, "created_at")


@router.get("/summary-chat-messages/{message_id}")
async def get_summary_chat_message(message_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Uma mensagem (o cliente consulta a resposta até `done` ou `failed`)."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        row = (
            (await conn.execute(select(t.summary_chat_messages).where(t.summary_chat_messages.c.id == message_id)))
            .mappings()
            .first()
        )
    if row is None:
        raise not_found("Mensagem inexistente ou sem acesso.")
    return chat_message_json(row)
