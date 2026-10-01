"""Chat sobre a base de gravações: o estado no Redis, as ferramentas sob a RLS e o job `base_chat`.

O estado vive no Redis (`eclume:basechat:{id}`, hash com `owner_id`, `status`, `request`, `result` e
`error`) por 1 h, como as pré-visualizações; o job `base_chat` do worker CPU roda o harness de
`agents/base_chat.py` e o preenche. Cada conta tem no máximo `MAX_OPEN` pedidos em aberto; além
disso, 429. As ferramentas abrem uma transação do dono a cada consulta, então só enxergam o que é
dele. Contrato em docs/standards/code/server-agentes.md.
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

TTL_S = 3600
# Pedidos em aberto (na fila ou rodando) por conta: cada um ocupa o agente por vários minutos.
MAX_OPEN = 2
_OPEN = {"queued", "running"}
NO_PROVIDER = "no_provider"
PROVIDER_NOT_CONFIGURED = "provider_not_configured"
SNIPPET_WORDS = "MaxWords=45, MinWords=20, ShortWord=2, StartSel=«, StopSel=»"
log = logging.getLogger(__name__)


def chat_key(chat_id: UUID | str) -> str:
    """Hash do estado do pedido."""
    return f"eclume:basechat:{chat_id}"


def open_key(owner_id: UUID | str) -> str:
    """Conjunto ordenado (pelo instante do pedido) dos pedidos em aberto da conta."""
    return f"eclume:basechat:open:{owner_id}"


def _decode(raw: dict[Any, Any]) -> dict[str, str]:
    return {
        (k.decode() if isinstance(k, bytes) else k): (v.decode() if isinstance(v, bytes) else v) for k, v in raw.items()
    }


async def _open_count(redis: ArqRedis, owner_id: UUID) -> int:
    """Quantos a conta tem em aberto, tirando do conjunto os que terminaram ou expiraram."""
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


async def create_chat(
    redis: ArqRedis, owner_id: UUID, message: str, history: list[dict[str, str]], *, transcripts: bool
) -> dict[str, Any]:
    """Guarda o pedido e enfileira `base_chat`; devolve o schema `BaseChat` na fila.

    `transcripts` diz se a credencial lê transcrições: sem isso, o agente só consulta resumos. Com
    `MAX_OPEN` em aberto, 429 `rate_limited`.
    """
    if await _open_count(redis, owner_id) >= MAX_OPEN:
        raise rate_limited(f"Já há {MAX_OPEN} perguntas em andamento; espere uma terminar.")
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
    """Schema `BaseChat`, se existe e é do usuário."""
    state = _decode(await redis.hgetall(chat_key(chat_id)))
    if state.get("owner_id") != str(owner_id):
        return None
    return _view(chat_id, state)


# --- as ferramentas, sob a RLS do dono -----------------------------------------------------------


def _one_line(text: str) -> str:
    return " ".join(text.split())


@dataclass(frozen=True)
class BaseTools:
    """`agents.base_chat.BaseTools` sobre o banco, como o usuário `owner_id`."""

    engine: AsyncEngine
    owner_id: UUID

    async def search_summaries(self, query: str, limit: int) -> list[Hit]:
        """As gravações cujo título, tags ou resumo atual batem com os termos, por relevância."""
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
        """O resumo atual (a maior versão concluída) da gravação."""
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
        """As falas que batem com os termos (a busca de `GET /search`), com a gravação e o momento."""
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
        """O título e as falas que cruzam `[from_ms, to_ms]`, em ordem."""
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


# --- o job `base_chat` ---------------------------------------------------------------------------


class ChatError(Exception):
    """Falha que vira `BaseChat.error`."""

    def __init__(self, code: str, message: str) -> None:
        """Código e mensagem legível."""
        super().__init__(message)
        self.code = code
        self.message = message


async def _answer(ctx: dict[str, Any], owner_id: UUID, request: dict[str, Any]) -> dict[str, Any]:
    async with system_tx(ctx["engine"]) as conn:
        public = await provider_for(conn, "chat")
        if public is None:
            raise ChatError(NO_PROVIDER, "Nenhum provider habilitado para o chat.")
        row, platform_key = await load_provider(conn, public["id"])
    try:
        provider = provider_factory(ctx)(provider_config(ctx["settings"], row, platform_key))
    except SecretDecryptError as exc:
        raise ChatError(PROVIDER_NOT_CONFIGURED, "A chave de API do provider não abre.") from exc
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
    """O job `base_chat`: responde a pergunta e grava o resultado (ou o erro) no Redis."""
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
        log.exception("chat da base %s: falha inesperada", chat_id)
        error = {"code": INTERNAL_ERROR, "message": type(exc).__name__}
    else:
        await redis.hset(key, mapping={"status": "done", "result": json.dumps(result, ensure_ascii=False)})
        await redis.zrem(open_key(state["owner_id"]), chat_id)
        return "done"
    await redis.hset(key, mapping={"status": "failed", "error": json.dumps(error, ensure_ascii=False)})
    await redis.zrem(open_key(state["owner_id"]), chat_id)
    return f"falhou: {error['code']}"


__all__ = ["BaseTools", "create_chat", "get_chat", "run_base_chat_job"]
