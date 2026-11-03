"""Chat over the recordings base: the state in Redis, the tools under RLS and the `base_chat` job.

The state lives in Redis (`eclume:basechat:{id}`, a hash with `owner_id`, `status`, `request`, `result`
and `error`) for 1 h, like the previews; the CPU worker's `base_chat` job runs the harness of
`agents/base_chat.py` and fills it. Each account has at most `MAX_OPEN` open requests; beyond
that, 429. The tools open an owner transaction for each query, so they only see what is
theirs. Contract in docs/standards/code/server-agentes.md.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

from sqlalchemy import and_, cast, func, select
from sqlalchemy.dialects.postgresql import REGCONFIG, distinct_on

from eclume_server.agents import ProviderError
from eclume_server.agents.base_chat import BaseChatContext, Hit, run_base_chat
from eclume_server.agents.prompting import hms
from eclume_server.crypto import SecretDecryptError
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.problems import rate_limited
from eclume_server.queue import AGENT_QUEUE
from eclume_server.quotas import refunding, take_agent_request
from eclume_server.search import CONFIG, SearchFilters, search
from eclume_server.summaries import (
    INTERNAL_ERROR,
    load_provider,
    provider_config,
    provider_factory,
    provider_for,
)
from eclume_server.summary_chat import CHAT_TIMEOUT_S

if TYPE_CHECKING:
    from arq.connections import ArqRedis
    from sqlalchemy.ext.asyncio import AsyncEngine

    from eclume_server.agents.base import Provider

TTL_S = 3600
# Open requests (queued or running) per account: each one occupies the agent for several minutes.
MAX_OPEN = 2
_OPEN = {"queued", "running"}
NO_PROVIDER = "no_provider"
PROVIDER_NOT_CONFIGURED = "provider_not_configured"
SNIPPET_WORDS = "MaxWords=45, MinWords=20, ShortWord=2, StartSel=«, StopSel=»"
log = logging.getLogger(__name__)


def chat_key(chat_id: UUID | str) -> str:
    """Hash of the request's state."""
    return f"eclume:basechat:{chat_id}"


def open_key(owner_id: UUID | str) -> str:
    """Sorted set (by the request's instant) of the account's open requests."""
    return f"eclume:basechat:open:{owner_id}"


def _decode(raw: dict[Any, Any]) -> dict[str, str]:
    return {
        (k.decode() if isinstance(k, bytes) else k): (v.decode() if isinstance(v, bytes) else v) for k, v in raw.items()
    }


async def _open_count(redis: ArqRedis, owner_id: UUID) -> int:
    """How many the account has open, removing from the set the ones that finished or expired."""
    key = open_key(owner_id)
    await redis.zremrangebyscore(key, "-inf", time.time() - TTL_S)
    for member in await redis.zrange(key, 0, -1):
        chat_id = member.decode() if isinstance(member, bytes) else member
        status = await redis.hget(chat_key(chat_id), "status")
        if (status.decode() if isinstance(status, bytes) else status) not in _OPEN:
            await redis.zrem(key, chat_id)
    return await redis.zcard(key)


def _view(chat_id: UUID | str, state: dict[str, str]) -> dict[str, Any]:
    result = json.loads(state["result"]) if state.get("result") else {}
    return {
        "id": str(chat_id),
        "status": state["status"],
        "answer": result.get("message"),
        "sources": result.get("sources", []),
        "queries": result.get("queries", 0),
        "model": result.get("model"),
        "error": json.loads(state["error"]) if state.get("error") else None,
    }


async def create_chat(  # noqa: PLR0913 — the request, the credential and the quota
    redis: ArqRedis,
    owner_id: UUID,
    message: str,
    history: list[dict[str, str]],
    *,
    transcripts: bool,
    agent_quota: int | None,
) -> dict[str, Any]:
    """Stores the request and enqueues `base_chat`; returns the queued `BaseChat` schema.

    `transcripts` says whether the credential reads transcripts: without it, the agent only queries
    summaries. With `MAX_OPEN` open, 429 `rate_limited`; the request counts against the 24 h
    `agent_quota` (403 `quota_exceeded`).
    """
    if await _open_count(redis, owner_id) >= MAX_OPEN:
        raise rate_limited(f"There are already {MAX_OPEN} questions in progress; wait for one to finish.")
    async with refunding(redis, owner_id) as charge:
        charge.token = await take_agent_request(redis, owner_id, agent_quota)
        chat_id = uuid4()
        key = chat_key(chat_id)
        request = json.dumps({"message": message, "history": history, "transcripts": transcripts}, ensure_ascii=False)
        await redis.hset(key, mapping={"owner_id": str(owner_id), "status": "queued", "request": request})
        await redis.expire(key, TTL_S)
        await redis.zadd(open_key(owner_id), {str(chat_id): time.time()})
        await redis.expire(open_key(owner_id), TTL_S)
        await redis.enqueue_job("base_chat", str(chat_id), _job_id=f"basechat:{chat_id}", _queue_name=AGENT_QUEUE)
    return _view(chat_id, {"status": "queued"})


async def get_chat(redis: ArqRedis, chat_id: UUID, owner_id: UUID) -> dict[str, Any] | None:
    """Schema `BaseChat`, if it exists and belongs to the user."""
    state = _decode(await redis.hgetall(chat_key(chat_id)))
    if state.get("owner_id") != str(owner_id):
        return None
    return _view(chat_id, state)


# --- the tools, under the owner's RLS ------------------------------------------------------------


def _one_line(text: str) -> str:
    return " ".join(text.split())


@dataclass(frozen=True)
class BaseTools:
    """`agents.base_chat.BaseTools` over the database, as the user `owner_id`."""

    engine: AsyncEngine
    owner_id: UUID

    async def search_summaries(self, query: str, limit: int) -> list[Hit]:
        """The recordings whose title, tags or current summary match the terms, by relevance."""
        s, tr, r = t.summaries.c, t.transcripts.c, t.recordings.c
        current = (
            select(s.transcript_id, s.content_md)
            .ext(distinct_on(s.transcript_id))
            .where(s.status == "done")
            .order_by(s.transcript_id, s.version.desc())
            .subquery("current")
        )
        config = cast(CONFIG, REGCONFIG)
        tsquery = func.websearch_to_tsquery(config, query)
        document = func.to_tsvector(
            config,
            func.coalesce(r.title, "")
            + " "
            + func.coalesce(func.array_to_string(r.tags, " "), "")
            + " "
            + current.c.content_md,
        )
        snippet = func.ts_headline(config, current.c.content_md, tsquery, SNIPPET_WORDS)
        stmt = (
            select(r.id, r.title, snippet.label("snippet"))
            .select_from(
                t.recordings.join(t.transcripts, tr.recording_id == r.id).join(
                    current, current.c.transcript_id == tr.id
                )
            )
            .where(document.op("@@")(tsquery))
            .order_by(func.ts_rank_cd(document, tsquery).desc(), r.recorded_at.desc(), r.id)
            .limit(limit)
        )
        async with user_tx(self.engine, self.owner_id) as conn:
            rows = (await conn.execute(stmt)).all()
        return [Hit(row.id, row.title, _one_line(row.snippet)) for row in rows]

    async def read_summary(self, recording_id: UUID) -> Hit | None:
        """The current summary (the highest completed version) of the recording."""
        s, tr, r = t.summaries.c, t.transcripts.c, t.recordings.c
        stmt = (
            select(r.title, s.content_md)
            .select_from(
                t.recordings.join(t.transcripts, tr.recording_id == r.id).join(t.summaries, s.transcript_id == tr.id)
            )
            .where(and_(r.id == recording_id, s.status == "done"))
            .order_by(s.version.desc())
            .limit(1)
        )
        async with user_tx(self.engine, self.owner_id) as conn:
            row = (await conn.execute(stmt)).first()
        return Hit(recording_id, row.title, row.content_md) if row else None

    async def search_transcripts(self, query: str, limit: int) -> list[Hit]:
        """The utterances that match the terms (the `GET /search` search), with the recording and the moment."""
        filters = SearchFilters(q=query, person=None, date_from=None, date_to=None, tag=None, collection=None)
        async with user_tx(self.engine, self.owner_id) as conn:
            found = await search(conn, filters, 0, limit)
        hits = []
        for item in found[:limit]:
            speaker = item["speaker"]
            who = (speaker["person"] or {}).get("name") or speaker["label"] or speaker["id"]
            line = f"[{hms(item['segment']['start_ms'])}] {who}: {item['segment']['text']}"
            transcript = item["transcript"]
            hits.append(Hit(UUID(transcript["recording_id"]), transcript["title"], line))
        return hits

    async def read_transcript(
        self, recording_id: UUID, from_ms: int, to_ms: int
    ) -> tuple[str, list[tuple[int, str]]] | None:
        """The title and the utterances that cross `[from_ms, to_ms]`, in order."""
        sg, tr, r, sp = t.segments.c, t.transcripts.c, t.recordings.c, t.speakers.c
        title_stmt = select(r.title).where(r.id == recording_id)
        stmt = (
            select(sg.start_ms, sg.text, sg.speaker_id, sp.label)
            .select_from(
                t.segments.join(t.transcripts, tr.id == sg.transcript_id).join(
                    t.speakers, and_(sp.transcript_id == sg.transcript_id, sp.speaker_id == sg.speaker_id)
                )
            )
            .where(and_(tr.recording_id == recording_id, sg.end_ms >= from_ms, sg.start_ms <= to_ms))
            .order_by(sg.start_ms, sg.position)
        )
        async with user_tx(self.engine, self.owner_id) as conn:
            title = (await conn.execute(title_stmt)).scalar()
            if title is None:
                return None
            rows = (await conn.execute(stmt)).all()
        return title, [
            (row.start_ms, f"[{hms(row.start_ms)}] {row.label or row.speaker_id}: {row.text}") for row in rows
        ]


# --- the `base_chat` job -------------------------------------------------------------------------


class ChatError(Exception):
    """Failure that becomes `BaseChat.error`."""

    def __init__(self, code: str, message: str) -> None:
        """Code and readable message."""
        super().__init__(message)
        self.code = code
        self.message = message


async def chat_provider(ctx: dict[str, Any]) -> Provider:
    """The provider marked for `chat` (the base chat and the Agent); without it, `ChatError`."""
    async with system_tx(ctx["engine"]) as conn:
        public = await provider_for(conn, "chat")
        if public is None:
            raise ChatError(NO_PROVIDER, "Nenhum provider habilitado para o chat.")
        row, platform_key = await load_provider(conn, public["id"])
    try:
        return provider_factory(ctx)(provider_config(ctx["settings"], row, platform_key))
    except SecretDecryptError as exc:
        raise ChatError(PROVIDER_NOT_CONFIGURED, "A chave de API do provider não abre.") from exc


async def _answer(ctx: dict[str, Any], owner_id: UUID, request: dict[str, Any]) -> dict[str, Any]:
    provider = await chat_provider(ctx)
    history = [(item["role"], item["content"]) for item in request.get("history", [])]
    context = BaseChatContext(
        history=history, question=request["message"], transcripts=request.get("transcripts", True)
    )
    result = await run_base_chat(provider, context, BaseTools(ctx["engine"], owner_id))
    return {
        "message": result.message,
        "sources": [{"recording_id": str(rid), "title": title} for rid, title in result.sources],
        "queries": len(result.calls),
        "model": result.completion.model if result.completion else None,
    }


async def run_base_chat_job(ctx: dict[str, Any], chat_id: str) -> str:
    """The `base_chat` job: answers the question and writes the result (or the error) to Redis."""
    redis: ArqRedis = ctx["redis"]
    key = chat_key(chat_id)
    state = _decode(await redis.hgetall(key))
    if not state:
        return "pergunta expirada"
    await redis.hset(key, "status", "running")
    try:
        async with asyncio.timeout(CHAT_TIMEOUT_S):
            result = await _answer(ctx, UUID(state["owner_id"]), json.loads(state["request"]))
    except (ChatError, ProviderError) as exc:
        error = {"code": exc.code, "message": exc.message}
    except TimeoutError:
        error = {"code": "provider_timeout", "message": "A pergunta passou do tempo limite."}
    except Exception as exc:
        log.exception("base chat %s: unexpected failure", chat_id)
        error = {"code": INTERNAL_ERROR, "message": type(exc).__name__}
    else:
        await redis.hset(key, mapping={"status": "done", "result": json.dumps(result, ensure_ascii=False)})
        await redis.zrem(open_key(state["owner_id"]), chat_id)
        return "done"
    await redis.hset(key, mapping={"status": "failed", "error": json.dumps(error, ensure_ascii=False)})
    await redis.zrem(open_key(state["owner_id"]), chat_id)
    return f"falhou: {error['code']}"


__all__ = ["BaseTools", "ChatError", "chat_provider", "create_chat", "get_chat", "run_base_chat_job"]
