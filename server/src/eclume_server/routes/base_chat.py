"""Chat over the recordings base: ask and poll the reply until `done` or `failed`.

The state lives 1 h in Redis; another account's request is 404. The agent sees only what belongs to
the owner (RLS). Contract in docs/standards/code/server-agentes.md.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from eclume_server.auth import Principal, requires
from eclume_server.base_chat import create_chat, get_chat
from eclume_server.context import AppContext, get_ctx
from eclume_server.db.session import user_tx
from eclume_server.problems import not_found
from eclume_server.quotas import agent_limit

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("summaries:read"))]


class BaseChatTurn(BaseModel):
    """Schema `BaseChatTurn`: one message of the conversation so far."""

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class BaseChatRequest(BaseModel):
    """Schema `BaseChatRequest`."""

    message: str = Field(min_length=1, max_length=4000)
    history: list[BaseChatTurn] = Field(default_factory=list, max_length=10)


@router.post("/base-chat", status_code=202, deprecated=True)
async def ask_base_chat(body: BaseChatRequest, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Store the question and enqueue `base_chat` on the CPU worker."""
    history = [turn.model_dump() for turn in body.history]
    # A session and a device credential read transcripts; a PAT, only with `transcripts:read`.
    transcripts = principal.method != "pat" or "transcripts:read" in principal.scopes
    async with user_tx(ctx.engine, principal.user_id) as conn:
        quota = await agent_limit(conn, principal.user_id)
    return await create_chat(
        ctx.queue.pool, principal.user_id, body.message, history, transcripts=transcripts, agent_quota=quota
    )


@router.get("/base-chat/{chat_id}", deprecated=True)
async def read_base_chat(chat_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """The question's state; the client polls until `done` or `failed`."""
    chat = await get_chat(ctx.queue.pool, chat_id, principal.user_id)
    if chat is None:
        raise not_found("Pergunta inexistente, expirada ou de outra conta.")
    return chat
