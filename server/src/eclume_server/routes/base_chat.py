"""Chat sobre a base de gravações: perguntar e consultar a resposta até `done` ou `failed`.

O estado vive 1 h no Redis; o pedido de outra conta é 404. O agente só enxerga o que é do dono
(RLS). Contrato em docs/standards/code/server-agentes.md.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from eclume_server.auth import Principal, requires
from eclume_server.base_chat import create_chat, get_chat
from eclume_server.context import AppContext, get_ctx
from eclume_server.problems import not_found

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("summaries:read"))]


class BaseChatTurn(BaseModel):
    """Schema `BaseChatTurn`: uma mensagem da conversa até aqui."""

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class BaseChatRequest(BaseModel):
    """Schema `BaseChatRequest`."""

    message: str = Field(min_length=1, max_length=4000)
    history: list[BaseChatTurn] = Field(default_factory=list, max_length=10)


@router.post("/base-chat", status_code=202)
async def ask_base_chat(body: BaseChatRequest, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Guarda a pergunta e enfileira o `base_chat` no worker CPU."""
    history = [turn.model_dump() for turn in body.history]
    return await create_chat(ctx.queue.pool, principal.user_id, body.message, history)


@router.get("/base-chat/{chat_id}")
async def read_base_chat(chat_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """O estado da pergunta; o cliente consulta até `done` ou `failed`."""
    chat = await get_chat(ctx.queue.pool, chat_id, principal.user_id)
    if chat is None:
        raise not_found("Pergunta inexistente, expirada ou de outra conta.")
    return chat
