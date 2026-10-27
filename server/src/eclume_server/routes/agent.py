"""The Agent: persisted conversations, attachments, questions with asynchronous answers and downloadable files.

Everything under the owner's RLS: another account's conversation, message or file is 404. The routes require
`summaries:read`, like `/base-chat`; reading transcripts remains the tools' job (session and
device credential yes, PAT only with `transcripts:read`). Contract in
docs/standards/code/server-agentes.md §Agente.

The actions the agent proposes (holetz/eclume#145) are confirmed or discarded here; confirming requires
the tool's write scope (`summaries:write` or `recordings:write`) and is idempotent.
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
    prepare_input_file,
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
from eclume_server.quotas import agent_limit, refunding, take_agent_request

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("summaries:read"))]


class AgentSessionCreate(BaseModel):
    """Schema `AgentSessionCreate`: the title is optional (the first question provides one)."""

    title: str = Field(default="", max_length=MAX_TITLE)


class AgentSessionUpdate(BaseModel):
    """Schema `AgentSessionUpdate`."""

    title: str = Field(min_length=1, max_length=MAX_TITLE)


class AgentMessageCreate(BaseModel):
    """Schema `AgentMessageCreate`: the question and the attachments of this conversation not yet sent."""

    message: str = Field(min_length=1, max_length=MAX_MESSAGE)
    attachments: list[UUID] = Field(default_factory=list, max_length=MAX_INPUTS_PER_MESSAGE)
    # The name of the skill chosen in the picker; `/name` at the start of the message counts the same.
    skill: str | None = Field(default=None, max_length=41)


WRITE_SCOPES = ("summaries:write", "recordings:write")


def _write_scopes(principal: Principal) -> frozenset[str]:
    # A session proposes every action; a PAT, only those of its write scopes.
    if principal.method != "pat":
        return frozenset(WRITE_SCOPES)
    return frozenset(scope for scope in WRITE_SCOPES if scope in principal.scopes)


def _transcripts(principal: Principal) -> bool:
    # Session and device credential read transcripts; a PAT, only with `transcripts:read`.
    return principal.method != "pat" or "transcripts:read" in principal.scopes


@router.get("/agent/sessions")
async def get_sessions(principal: Reader, ctx: Ctx, limit: Limit = 50, cursor: Cursor = None) -> dict[str, Any]:
    """The account's conversations, from the latest activity backwards."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await list_sessions(conn, cursor, limit)


@router.post("/agent/sessions", status_code=201)
async def post_session(principal: Reader, ctx: Ctx, body: AgentSessionCreate | None = None) -> dict[str, Any]:
    """Opens a conversation."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await create_session(conn, principal.user_id, (body or AgentSessionCreate()).title)


@router.get("/agent/sessions/{session_id}")
async def get_session(session_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """The conversation with its messages, files and attachments not yet sent."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await session_detail(conn, session_id)


@router.patch("/agent/sessions/{session_id}")
async def patch_session(session_id: UUID, body: AgentSessionUpdate, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Renames the conversation."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await rename_session(conn, session_id, body.title)


@router.delete("/agent/sessions/{session_id}", status_code=204)
async def remove_session(session_id: UUID, principal: Reader, ctx: Ctx) -> Response:
    """Deletes the conversation, its messages and files (the bucket is cleaned by the deletion queue)."""
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
    """Attaches a file to the conversation and extracts its text; it goes with the next question."""
    data = await file.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise payload_too_large(MAX_INPUT_BYTES)
    prepared = await prepare_input_file(file.filename or "", data)
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await add_input_file(conn, ctx.storage, principal.user_id, session_id, prepared)


@router.delete("/agent/sessions/{session_id}/files/{file_id}", status_code=204)
async def remove_file(session_id: UUID, file_id: UUID, principal: Reader, ctx: Ctx) -> Response:
    """Removes an attachment that has not yet gone with a question."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await delete_input_file(conn, session_id, file_id)
    return Response(status_code=204)


@router.post("/agent/sessions/{session_id}/messages", status_code=202)
async def post_message(session_id: UUID, body: AgentMessageCreate, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Stores the question and enqueues the answer; the client polls the answer until `done` or `failed`."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        quota = await agent_limit(conn, principal.user_id)
    async with refunding(ctx.queue.pool, principal.user_id) as charge:
        charge.token = await take_agent_request(ctx.queue.pool, principal.user_id, quota)
        async with user_tx(ctx.engine, principal.user_id) as conn:
            turn = await send_message(
                conn, principal.user_id, session_id, body.message, body.attachments, skill=body.skill
            )
        await enqueue_turn(
            ctx.queue.pool, turn.answer_id, transcripts=_transcripts(principal), scopes=_write_scopes(principal)
        )
    return {"question": turn.question, "answer": turn.answer}


@router.get("/agent/sessions/{session_id}/messages/{message_id}")
async def get_message(session_id: UUID, message_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """A message of the conversation (the answer, until `done` or `failed`)."""
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
    """The content of an attachment or a generated file, for download."""
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
    """The log of the actions the Agent proposed, from the most recent backwards."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await list_actions(conn, cursor, limit)


@router.get("/agent/actions/{action_id}")
async def get_action(action_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """An action, with the result per target (polled until `done` or `failed`)."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await read_action(conn, action_id)


@router.post("/agent/actions/{action_id}/confirm", status_code=202)
async def post_confirm(action_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Confirms the proposal and enqueues the execution; confirming again returns the state without repeating."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        action, enqueue = await confirm_action(conn, principal, action_id)
    if enqueue:
        await enqueue_action(ctx.queue.pool, action_id)
    return action


@router.post("/agent/actions/{action_id}/cancel")
async def post_cancel(action_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Discards the proposal not yet confirmed."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await cancel_action(conn, action_id)
