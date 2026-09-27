"""Chat de ajuste do resumo: o pedido, a resposta em aberto e o job `summary_chat` do worker CPU.

O pedido e a resposta nascem juntos (a resposta `queued`, com a versão atual em
`base_summary_id`); o job chama o agente marcado para `chat` pelo protocolo de `agents/chat.py`,
com as ferramentas restritas à transcrição da mensagem, e grava a resposta. Um `summary_md` vira
uma versão `chat`, se a atual ainda for a de base. Contrato em docs/standards/code/server-agentes.md.
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
# O teto de um ajuste inteiro (todas as chamadas do laço): um chat não espera como um resumo.
CHAT_TIMEOUT_S = 5 * 60
CHAT_RETRY_S = 10
# Além do pior caso do job (duas tentativas no teto do arq e a espera entre elas), a resposta em
# aberto não vai mais terminar: o worker morreu ou o job nunca chegou à fila.
CHAT_STALE_S = 15 * 60
# Falha passageira do outro lado: uma nova tentativa só.
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


# --- o pedido (API, sob a RLS do dono) -----------------------------------------------------------


async def open_request(conn: AsyncConnection, transcript: Row, message: str, user_id: UUID) -> tuple[Row, Row]:
    """Grava o pedido e a resposta em aberto; já havendo um pedido em aberto, 409 `chat_busy`."""
    m = t.summary_chat_messages.c
    busy = await conn.execute(
        select(m.id).where(
            m.recording_id == transcript["recording_id"], m.role == "assistant", m.status.in_(["queued", "running"])
        )
    )
    if busy.first() is not None:
        raise conflict("Já há um pedido de ajuste em andamento nesta gravação.", code=CHAT_BUSY)
    current = await current_version(conn, transcript["id"])
    # `clock_timestamp()`: o pedido e a resposta nascem na mesma transação e precisam de ordem.
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
        raise conflict("Já há um pedido de ajuste em andamento nesta gravação.", code=CHAT_BUSY) from exc
    return request, reply


# --- o job `summary_chat` (worker CPU, papel de conexão) -------------------------------------------


class TranscriptTools:
    """As ferramentas do chat, restritas à transcrição da mensagem."""

    def __init__(self, engine: AsyncEngine, transcript_id: UUID, speakers: dict[str, str]) -> None:
        """A transcrição e os nomes dos locutores (`S1` → nome), como no resumo."""
        self.engine, self.transcript_id, self.speakers = engine, transcript_id, speakers

    def _line(self, speaker_id: str, start_ms: int, content: str) -> str:
        return f"[{hms(start_ms)}] {self.speakers.get(speaker_id, speaker_id)}: {content.strip()}"

    async def read(self, from_ms: int, to_ms: int) -> list[tuple[int, str]]:
        """As falas que cruzam `[from_ms, to_ms]`, em ordem."""
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
        """O full-text `eclume_pt` da busca, só nesta transcrição: os mais relevantes, em ordem de tempo."""
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
    """O cabeçalho (com duração e marcadores com nota), o resumo de base, a conversa e o pedido."""
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
    log.warning("chat %s falhou: %s — %s", message_id, code, message)
    return f"falhou: {code}"


async def abandon_reply(engine: AsyncEngine, message_id: UUID) -> None:
    """Falha a resposta cujo job não entrou na fila: sem isso, a gravação ficaria em `chat_busy`."""
    await _fail(engine, message_id, INTERNAL_ERROR, "O pedido de ajuste não chegou ao worker; peça de novo.")


async def reap_stalled_chats(engine: AsyncEngine) -> int:
    """Falha as respostas em aberto há mais de `CHAT_STALE_S`, que ninguém mais vai terminar."""
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
        log.warning("chat: %d resposta(s) em aberto abandonada(s)", result.rowcount)
    return result.rowcount


async def _save(engine: AsyncEngine, reply: Row, provider: Row, result: ChatResult) -> str:
    """Grava a resposta; o resumo novo vira versão `chat` se a atual ainda for a de base."""
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
    """A resposta em curso, o provider de chat (com o segredo da plataforma) e o que o agente vê."""

    reply: Row
    provider: Row | None
    platform_key: str | None
    context: ChatContext
    speakers: dict[str, str]


async def _claim(engine: AsyncEngine, message_id: UUID) -> _Claim | str:
    """Passa a resposta a `running` com o provider de chat; o desfecho, se não há o que fazer."""
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
    """A GPU ocupada falha na hora; falha passageira tenta de novo uma vez; o resto falha."""
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
        # Fora da transação: o `Retry` dentro dela desfaria a volta à fila.
        raise Retry(defer=ctx.get("retry_delays", (CHAT_RETRY_S,))[0]) from exc
    return await _fail(engine, reply["id"], exc.code, exc.message)


async def run_summary_chat(ctx: dict[str, Any], message_id: UUID) -> str:  # noqa: PLR0911 — um desfecho por caminho do job
    """O job `summary_chat`: roda o laço do agente e grava a resposta (e a versão `chat`).

    `ctx` é o do worker arq; nos testes, com `provider_factory` e `retry_delays`.
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
        log.exception("chat %s: falha inesperada", message_id)
        return await _fail(engine, message_id, INTERNAL_ERROR, "Falha inesperada no ajuste do resumo.")
    return await _save(engine, claim.reply, claim.provider, result)
