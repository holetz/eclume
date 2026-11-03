"""Summary adjustment chat: the request, the open reply and the CPU worker's `summary_chat` job.

The request and the reply are born together (the reply `queued`, with the current version in
`base_summary_id`); the job calls the agent marked for `chat` through the protocol of `agents/chat.py`,
with the tools restricted to the message's transcript, and writes the reply. A `summary_md` becomes
a `chat` version, if the current one is still the base one. Contract in docs/standards/code/server-agentes.md.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from arq import Retry
from sqlalchemy import func, insert, select, text, update
from sqlalchemy.exc import IntegrityError

from eclume_server.agents import ProviderError
from eclume_server.agents.base import (
    GPU_BUSY,
    PROVIDER_NOT_CONFIGURED,
    PROVIDER_RATE_LIMITED,
    PROVIDER_TIMEOUT,
    PROVIDER_UNAVAILABLE,
)
from eclume_server.agents.chat import ChatContext, ChatResult, run_chat
from eclume_server.agents.prompting import hms
from eclume_server.crypto import SecretDecryptError
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.pagination import iso
from eclume_server.problems import conflict
from eclume_server.summaries import (
    INTERNAL_ERROR,
    SUMMARY_CHANGED,
    add_version,
    current_version,
    load_provider,
    lock_versions,
    provider_config,
    provider_factory,
    provider_for,
    provider_ref,
    transcript_text,
)

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

    from eclume_server.serialize import Row

log = logging.getLogger(__name__)

CHAT_BUSY = "chat_busy"
# The ceiling of a whole adjustment (every call of the loop): a chat does not wait like a summary.
CHAT_TIMEOUT_S = 5 * 60
CHAT_RETRY_S = 10
# Beyond the job's worst case (two attempts at the arq ceiling and the wait between them), the open
# reply will no longer finish: the worker died or the job never reached the queue.
CHAT_STALE_S = 15 * 60
# Transient failure on the other side: one retry only.
_RETRYABLE = {PROVIDER_TIMEOUT, PROVIDER_RATE_LIMITED, PROVIDER_UNAVAILABLE}
GONE = "gravação apagada"


def _id(value: UUID | None) -> str | None:
    return str(value) if value is not None else None


def chat_message_json(row: Row) -> dict[str, Any]:
    """Schema `SummaryChatMessage`."""
    error = None
    if row["error_code"]:
        error = {"code": row["error_code"], "message": row["error_message"] or ""}
    return {
        "id": str(row["id"]),
        "recording_id": str(row["recording_id"]),
        "role": row["role"],
        "content": row["content"],
        "status": row["status"],
        "reply_to": _id(row["reply_to"]),
        "base_summary_id": _id(row["base_summary_id"]),
        "summary_id": _id(row["summary_id"]),
        "reads": list(row["reads"] or []),
        "provider": provider_ref(row),
        "model": row["model"],
        "error": error,
        "created_by": _id(row["created_by"]),
        "created_at": iso(row["created_at"]),
        "completed_at": iso(row["completed_at"]),
    }


# --- the request (API, under the owner's RLS) ----------------------------------------------------


async def open_request(conn: AsyncConnection, transcript: Row, message: str, user_id: UUID) -> tuple[Row, Row]:
    """Writes the request and the open reply; with a request already open, 409 `chat_busy`."""
    m = t.summary_chat_messages.c
    busy = await conn.execute(
        select(m.id).where(
            m.recording_id == transcript["recording_id"], m.role == "assistant", m.status.in_(["queued", "running"])
        )
    )
    if busy.first() is not None:
        raise conflict("An adjustment request is already in progress on this recording.", code=CHAT_BUSY)
    current = await current_version(conn, transcript["id"])
    # `clock_timestamp()`: the request and the reply are born in the same transaction and need an order.
    base = {
        "owner_id": transcript["owner_id"],
        "recording_id": transcript["recording_id"],
        "created_by": user_id,
        "created_at": func.clock_timestamp(),
    }
    returning = insert(t.summary_chat_messages).returning(t.summary_chat_messages)
    request = (
        (
            await conn.execute(
                returning.values(**base, transcript_id=transcript["id"], role="user", content=message, status="done")
            )
        )
        .mappings()
        .one()
    )
    try:
        async with conn.begin_nested():
            reply = (
                (
                    await conn.execute(
                        returning.values(
                            **base,
                            transcript_id=transcript["id"],
                            role="assistant",
                            status="queued",
                            reply_to=request["id"],
                            base_summary_id=current["id"] if current else None,
                        )
                    )
                )
                .mappings()
                .one()
            )
    except IntegrityError as exc:
        raise conflict("An adjustment request is already in progress on this recording.", code=CHAT_BUSY) from exc
    return request, reply


# --- the `summary_chat` job (CPU worker, connection role) ------------------------------------------


class TranscriptTools:
    """The chat tools, restricted to the message's transcript."""

    def __init__(self, engine: AsyncEngine, transcript_id: UUID, speakers: dict[str, str]) -> None:
        """The transcript and the speakers' names (`S1` → name), as in the summary."""
        self.engine, self.transcript_id, self.speakers = engine, transcript_id, speakers

    def _line(self, speaker_id: str, start_ms: int, content: str) -> str:
        return f"[{hms(start_ms)}] {self.speakers.get(speaker_id, speaker_id)}: {content.strip()}"

    async def read(self, from_ms: int, to_ms: int) -> list[tuple[int, str]]:
        """The utterances that cross `[from_ms, to_ms]`, in order."""
        g = t.segments.c
        query = (
            select(g.speaker_id, g.start_ms, g.text)
            .where(g.transcript_id == self.transcript_id, g.end_ms >= from_ms, g.start_ms <= to_ms)
            .order_by(g.position)
        )
        async with system_tx(self.engine) as conn:
            rows = (await conn.execute(query)).all()
        return [(row.start_ms, self._line(row.speaker_id, row.start_ms, row.text)) for row in rows if row.text.strip()]

    async def search(self, query: str, limit: int) -> list[str]:
        """The search's `eclume_pt` full-text, in this transcript only: the most relevant, in time order."""
        sql = text(
            """
            SELECT speaker_id, start_ms, text FROM (
                SELECT s.speaker_id, s.start_ms, s.text, s.position
                FROM segments s, websearch_to_tsquery('eclume_pt', :q) q
                WHERE s.transcript_id = :t AND s.tsv @@ q
                ORDER BY ts_rank_cd(s.tsv, q) DESC, s.position
                LIMIT :limit
            ) hits ORDER BY position
            """
        )
        async with system_tx(self.engine) as conn:
            rows = (await conn.execute(sql, {"q": query, "t": self.transcript_id, "limit": limit})).all()
        return [self._line(row.speaker_id, row.start_ms, row.text) for row in rows]


async def _context(conn: AsyncConnection, reply: Row) -> tuple[ChatContext, dict[str, str]]:
    """The header (with duration and markers with a note), the base summary, the conversation and the request."""
    transcript = await transcript_text(conn, reply["transcript_id"])
    duration = (
        await conn.execute(select(t.transcripts.c.duration_ms).where(t.transcripts.c.id == reply["transcript_id"]))
    ).scalar()
    header = transcript.header + f"\nDuração: {hms(duration or 0)}"
    mk = t.markers.c
    notes = (
        await conn.execute(
            select(mk.at_ms, mk.note)
            .where(mk.recording_id == reply["recording_id"], mk.note.is_not(None))
            .order_by(mk.at_ms)
        )
    ).all()
    if notes:
        header += "\nMarcadores:\n" + "\n".join(f"- [{hms(at_ms)}] {note}" for at_ms, note in notes)
    summary = None
    if reply["base_summary_id"] is not None:
        summary = (
            await conn.execute(select(t.summaries.c.content_md).where(t.summaries.c.id == reply["base_summary_id"]))
        ).scalar()
    m = t.summary_chat_messages.c
    earlier = (
        await conn.execute(
            select(m.role, m.content)
            .where(
                m.recording_id == reply["recording_id"],
                m.status == "done",
                m.content.is_not(None),
                m.created_at < reply["created_at"],
                m.id != reply["reply_to"],
            )
            .order_by(m.created_at.desc(), m.id.desc())
            .limit(10)
        )
    ).all()
    request = (await conn.execute(select(m.content).where(m.id == reply["reply_to"]))).scalar_one()
    speakers = dict(
        (
            await conn.execute(
                select(t.speakers.c.speaker_id, t.speakers.c.label).where(
                    t.speakers.c.transcript_id == reply["transcript_id"]
                )
            )
        ).all()
    )
    context = ChatContext(
        header=header,
        summary_md=summary,
        history=[(role, content) for role, content in reversed(earlier)],
        request=request,
    )
    return context, speakers


async def _fail(engine: AsyncEngine, message_id: UUID, code: str, message: str) -> str:
    async with system_tx(engine) as conn:
        await conn.execute(
            update(t.summary_chat_messages)
            .where(t.summary_chat_messages.c.id == message_id)
            .values(status="failed", error_code=code, error_message=message, completed_at=func.now())
        )
    log.warning("chat %s failed: %s — %s", message_id, code, message)
    return f"falhou: {code}"


async def abandon_reply(engine: AsyncEngine, message_id: UUID) -> None:
    """Fails the reply whose job did not enter the queue: without this, the recording would stay in `chat_busy`."""
    await _fail(engine, message_id, INTERNAL_ERROR, "O pedido de ajuste não chegou ao worker; peça de novo.")


async def reap_stalled_chats(engine: AsyncEngine) -> int:
    """Fails the replies open for longer than `CHAT_STALE_S`, which nobody will finish anymore."""
    m = t.summary_chat_messages.c
    async with system_tx(engine) as conn:
        result = await conn.execute(
            update(t.summary_chat_messages)
            .where(
                m.role == "assistant",
                m.status.in_(["queued", "running"]),
                m.created_at < func.now() - timedelta(seconds=CHAT_STALE_S),
            )
            .values(
                status="failed",
                error_code=INTERNAL_ERROR,
                error_message="O ajuste não terminou; peça de novo.",
                completed_at=func.now(),
            )
        )
    if result.rowcount:
        log.warning("chat: %d open reply(ies) abandoned", result.rowcount)
    return result.rowcount


async def _save(engine: AsyncEngine, reply: Row, provider: Row, result: ChatResult) -> str:
    """Writes the reply; the new summary becomes a `chat` version if the current one is still the base one."""
    model = result.completion.model if result.completion else provider["model"]
    async with system_tx(engine) as conn:
        await lock_versions(conn, reply["transcript_id"])
        m = t.summary_chat_messages.c
        if (await conn.execute(select(m.id).where(m.id == reply["id"]).with_for_update())).first() is None:
            return GONE
        values: dict[str, Any] = {
            "status": "done",
            "content": result.message,
            "reads": result.reads,
            "model": model,
            "completed_at": func.now(),
        }
        if result.summary_md is not None:
            current = await current_version(conn, reply["transcript_id"])
            if (current["id"] if current else None) == reply["base_summary_id"]:
                transcript = (
                    (await conn.execute(select(t.transcripts).where(t.transcripts.c.id == reply["transcript_id"])))
                    .mappings()
                    .one()
                )
                version = await add_version(
                    conn,
                    transcript=transcript,
                    content_md=result.summary_md,
                    origin="chat",
                    base=current,
                    created_by=reply["created_by"],
                    agent=(provider, model),
                    chat_message_id=reply["id"],
                )
                values["summary_id"] = version["id"]
            else:
                values["error_code"] = SUMMARY_CHANGED
                values["error_message"] = "O resumo mudou durante o ajuste; a versão nova não foi criada."
        await conn.execute(update(t.summary_chat_messages).where(m.id == reply["id"]).values(**values))
    return f"done: {values['error_code']}" if "error_code" in values else "done"


@dataclass(frozen=True)
class _Claim:
    """The reply in progress, the chat provider (with the platform secret) and what the agent sees."""

    reply: Row
    provider: Row | None
    platform_key: str | None
    context: ChatContext
    speakers: dict[str, str]


async def _claim(engine: AsyncEngine, message_id: UUID) -> _Claim | str:
    """Moves the reply to `running` with the chat provider; the outcome, if there is nothing to do."""
    async with system_tx(engine) as conn:
        m = t.summary_chat_messages.c
        reply = (
            (await conn.execute(select(t.summary_chat_messages).where(m.id == message_id).with_for_update()))
            .mappings()
            .first()
        )
        if reply is None:
            return GONE
        if reply["status"] not in {"queued", "running"}:
            return f"mensagem já {reply['status']}"
        public = await provider_for(conn, "chat")
        provider, platform_key = await load_provider(conn, public["id"]) if public else (None, None)
        values: dict[str, Any] = {"status": "running", "started_at": func.coalesce(m.started_at, func.now())}
        if provider is not None:
            values |= {
                "attempts": m.attempts + 1,
                "provider_id": provider["id"],
                "provider_name": provider["name"],
                "provider_kind": provider["kind"],
            }
        await conn.execute(update(t.summary_chat_messages).where(m.id == message_id).values(**values))
        context, speakers = await _context(conn, reply)
    return _Claim(reply, provider, platform_key, context, speakers)


async def _on_error(ctx: dict[str, Any], reply: Row, exc: ProviderError) -> str:
    """A busy GPU fails at once; a transient failure retries once; the rest fails."""
    engine: AsyncEngine = ctx["engine"]
    if exc.code == GPU_BUSY:
        return await _fail(engine, reply["id"], GPU_BUSY, "A GPU está transcrevendo; tente em instantes.")
    if exc.code in _RETRYABLE and reply["attempts"] == 0:
        async with system_tx(engine) as conn:
            await conn.execute(
                update(t.summary_chat_messages)
                .where(t.summary_chat_messages.c.id == reply["id"])
                .values(status="queued")
            )
        # Outside the transaction: the `Retry` inside it would undo the requeue.
        raise Retry(defer=ctx.get("retry_delays", (CHAT_RETRY_S,))[0]) from exc
    return await _fail(engine, reply["id"], exc.code, exc.message)


async def run_summary_chat(ctx: dict[str, Any], message_id: UUID) -> str:  # noqa: PLR0911 — one outcome per job path
    """The `summary_chat` job: runs the agent loop and writes the reply (and the `chat` version).

    `ctx` is the arq worker's; in the tests, with `provider_factory` and `retry_delays`.
    """
    engine: AsyncEngine = ctx["engine"]
    claim = await _claim(engine, message_id)
    if isinstance(claim, str):
        return claim
    if claim.provider is None:
        return await _fail(engine, message_id, PROVIDER_NOT_CONFIGURED, "A plataforma não tem agente para o chat.")
    try:
        config = provider_config(ctx["settings"], claim.provider, claim.platform_key)
    except SecretDecryptError:
        message = "A chave de API do agente de chat não abre com a chave de cifra atual."
        return await _fail(engine, message_id, PROVIDER_NOT_CONFIGURED, message)
    tools = TranscriptTools(engine, claim.reply["transcript_id"], claim.speakers)
    try:
        async with asyncio.timeout(CHAT_TIMEOUT_S):
            result = await run_chat(provider_factory(ctx)(config), claim.context, tools)
    except TimeoutError:
        return await _fail(engine, message_id, PROVIDER_TIMEOUT, f"O ajuste passou de {CHAT_TIMEOUT_S // 60} min.")
    except ProviderError as exc:
        return await _on_error(ctx, claim.reply, exc)
    except Exception:
        log.exception("chat %s: unexpected failure", message_id)
        return await _fail(engine, message_id, INTERNAL_ERROR, "Falha inesperada no ajuste do resumo.")
    return await _save(engine, claim.reply, claim.provider, result)
