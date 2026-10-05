"""As conversas do Agente: sessões, mensagens e arquivos no Postgres, e o job `agent_turn`.

Tudo vive sob a RLS do dono (`user_tx`): outra conta não enxerga nada, e a rota responde 404. A
pergunta grava a mensagem `user`, liga os anexos a ela, cria a resposta `assistant` em `queued` e,
depois do commit, enfileira `agent_turn` no worker de agentes, que roda o laço de
`agents/agent.py` e grava a resposta, as fontes e os arquivos gerados (no bucket, sob o dono). A
conta tem até `MAX_OPEN` respostas em aberto e a conversa, uma. Uma resposta em aberto há mais de
`STALE_AFTER` vira `failed` (`agent_expired`) na leitura. Contrato em
docs/standards/code/server-agentes.md §Agente.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

from sqlalchemy import and_, delete, func, insert, select, tuple_, update

from eclume_server.agent_files import (
    MAX_INPUT_BYTES,
    MAX_INPUTS_PER_MESSAGE,
    MAX_INPUTS_PER_SESSION,
    FileRejectedError,
    clean_name,
    extract_text,
    file_key,
    render_output,
)
from eclume_server.agents import ProviderError
from eclume_server.agents.agent import AgentContext, AttachedFile, run_agent
from eclume_server.agents.agent_tools import InputFile
from eclume_server.base_chat import BaseTools, ChatError, chat_provider
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.pagination import decode_cursor, encode_cursor, iso
from eclume_server.problems import (
    conflict,
    invalid_field,
    not_found,
    payload_too_large,
    rate_limited,
    unsupported_media_type,
)
from eclume_server.queue import AGENT_QUEUE
from eclume_server.summaries import INTERNAL_ERROR
from eclume_server.summary_chat import CHAT_TIMEOUT_S

if TYPE_CHECKING:
    from arq.connections import ArqRedis
    from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

    from eclume_server.serialize import Row
    from eclume_server.storage import Storage

MAX_OPEN = 2
MAX_TITLE = 120
MAX_MESSAGE = 4000
HISTORY = 10
STALE_AFTER = timedelta(seconds=CHAT_TIMEOUT_S + 600)
OPEN = ("queued", "running")
AGENT_EXPIRED = "agent_expired"
log = logging.getLogger(__name__)

S, M, F = t.agent_sessions.c, t.agent_messages.c, t.agent_files.c


# --- vistas --------------------------------------------------------------------------------------


def session_json(row: Row) -> dict[str, Any]:
    """Schema `AgentSession`."""
    return {
        "id": str(row["id"]),
        "title": row["title"],
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
    }


def file_json(row: Row) -> dict[str, Any]:
    """Schema `AgentFile`; o conteúdo se baixa em `GET /agent/files/{id}/content`."""
    text = row.get("text_content")
    return {
        "id": str(row["id"]),
        "session_id": str(row["session_id"]),
        "message_id": str(row["message_id"]) if row["message_id"] else None,
        "direction": row["direction"],
        "name": row["name"],
        "media_type": row["media_type"],
        "size_bytes": row["size_bytes"],
        # Só a entrada tem texto; o anexo sem texto legível (PDF escaneado) avisa na tela.
        "text_chars": len(text) if text is not None else None,
        "created_at": iso(row["created_at"]),
    }


def message_json(row: Row, files: list[dict[str, Any]]) -> dict[str, Any]:
    """Schema `AgentMessage`, com os arquivos ligados a ela."""
    return {
        "id": str(row["id"]),
        "session_id": str(row["session_id"]),
        "role": row["role"],
        "content": row["content"],
        "status": row["status"],
        "sources": row["sources"] or [],
        "queries": row["queries"],
        "model": row["model"],
        "error": row["error"],
        "files": files,
        "created_at": iso(row["created_at"]),
    }


_FILE_COLUMNS = (
    F.id,
    F.session_id,
    F.message_id,
    F.direction,
    F.name,
    F.media_type,
    F.size_bytes,
    F.text_content,
    F.created_at,
)


# --- sessões -------------------------------------------------------------------------------------


async def _session(conn: AsyncConnection, session_id: UUID, *, lock: bool = False) -> Row:
    stmt = select(t.agent_sessions).where(S.id == session_id)
    if lock:
        stmt = stmt.with_for_update()
    row = (await conn.execute(stmt)).mappings().first()
    if row is None:
        raise not_found("Conversa inexistente ou de outra conta.")
    return row


def _title(value: str) -> str:
    return " ".join(value.split())[:MAX_TITLE]


async def list_sessions(conn: AsyncConnection, cursor: str | None, limit: int) -> dict[str, Any]:
    """As conversas da conta, da mais recente para a mais antiga (`updated_at`)."""
    stmt = select(t.agent_sessions).order_by(S.updated_at.desc(), S.id.desc()).limit(limit + 1)
    if cursor:
        stmt = stmt.where(tuple_(S.updated_at, S.id) < decode_cursor(cursor))
    rows = (await conn.execute(stmt)).mappings().all()
    last = rows[limit - 1] if len(rows) > limit else None
    return {
        "items": [session_json(row) for row in rows[:limit]],
        "next_cursor": encode_cursor(last["updated_at"], last["id"]) if last else None,
    }


async def create_session(conn: AsyncConnection, owner_id: UUID, title: str) -> dict[str, Any]:
    """Uma conversa nova; sem título, a primeira pergunta dá o título."""
    stmt = insert(t.agent_sessions).values(owner_id=owner_id, title=_title(title)).returning(t.agent_sessions)
    row = (await conn.execute(stmt)).mappings().one()
    return session_json(row)


async def rename_session(conn: AsyncConnection, session_id: UUID, title: str) -> dict[str, Any]:
    """Troca o título (sem mexer na última atividade)."""
    await _session(conn, session_id)
    stmt = update(t.agent_sessions).where(S.id == session_id).values(title=_title(title)).returning(t.agent_sessions)
    row = (await conn.execute(stmt)).mappings().one()
    return session_json(row)


async def delete_session(conn: AsyncConnection, session_id: UUID) -> None:
    """Exclui a conversa; as mensagens e os arquivos saem em cascata, e o gatilho limpa o bucket."""
    await _session(conn, session_id)
    await conn.execute(delete(t.agent_sessions).where(S.id == session_id))


async def expire_stale(conn: AsyncConnection, session_id: UUID | None = None) -> None:
    """Marca `failed` as respostas em aberto há mais de `STALE_AFTER` (o job morreu ou sumiu)."""
    stmt = (
        update(t.agent_messages)
        .where(and_(M.status.in_(OPEN), M.created_at < func.now() - STALE_AFTER))
        .values(status="failed", error={"code": AGENT_EXPIRED, "message": "A resposta passou do tempo limite."})
    )
    if session_id is not None:
        stmt = stmt.where(M.session_id == session_id)
    await conn.execute(stmt)


async def _files_by_message(
    conn: AsyncConnection, session_id: UUID
) -> tuple[dict[UUID, list[dict[str, Any]]], list[dict[str, Any]]]:
    stmt = select(*_FILE_COLUMNS).where(F.session_id == session_id).order_by(F.created_at, F.id)
    rows = (await conn.execute(stmt)).mappings().all()
    by_message: dict[UUID, list[dict[str, Any]]] = {}
    pending: list[dict[str, Any]] = []
    for row in rows:
        if row["message_id"] is None:
            pending.append(file_json(row))
        else:
            by_message.setdefault(row["message_id"], []).append(file_json(row))
    return by_message, pending


async def session_detail(conn: AsyncConnection, session_id: UUID) -> dict[str, Any]:
    """Schema `AgentSessionDetail`: a conversa, as mensagens em ordem e os anexos ainda não enviados."""
    session = await _session(conn, session_id)
    await expire_stale(conn, session_id)
    by_message, pending = await _files_by_message(conn, session_id)
    stmt = select(t.agent_messages).where(M.session_id == session_id).order_by(M.created_at, M.id)
    rows = (await conn.execute(stmt)).mappings().all()
    return session_json(session) | {
        "messages": [message_json(row, by_message.get(row["id"], [])) for row in rows],
        "pending_files": pending,
    }


async def read_message(conn: AsyncConnection, session_id: UUID, message_id: UUID) -> dict[str, Any]:
    """Schema `AgentMessage` (a consulta da resposta até `done` ou `failed`)."""
    await expire_stale(conn, session_id)
    row = (
        (await conn.execute(select(t.agent_messages).where(and_(M.id == message_id, M.session_id == session_id))))
        .mappings()
        .first()
    )
    if row is None:
        raise not_found("Mensagem inexistente ou de outra conta.")
    files = (
        (await conn.execute(select(*_FILE_COLUMNS).where(F.message_id == message_id).order_by(F.created_at, F.id)))
        .mappings()
        .all()
    )
    return message_json(row, [file_json(item) for item in files])


# --- anexos --------------------------------------------------------------------------------------


async def add_input_file(  # noqa: PLR0913 — a conversa, o dono, o arquivo e o storage
    conn: AsyncConnection,
    storage: Storage,
    owner_id: UUID,
    session_id: UUID,
    name: str,
    data: bytes,
) -> dict[str, Any]:
    """Guarda o anexo e o texto extraído; 413 acima do teto, 415 fora dos tipos, 409 na conversa cheia."""
    if len(data) > MAX_INPUT_BYTES:
        raise payload_too_large(MAX_INPUT_BYTES)
    await _session(conn, session_id, lock=True)
    count = (
        await conn.execute(
            select(func.count())
            .select_from(t.agent_files)
            .where(and_(F.session_id == session_id, F.direction == "input"))
        )
    ).scalar_one()
    if count >= MAX_INPUTS_PER_SESSION:
        raise conflict(f"A conversa já tem {MAX_INPUTS_PER_SESSION} anexos; comece uma nova.", "too_many_files")
    filename = clean_name(name)
    try:
        extracted = await asyncio.to_thread(extract_text, filename, data)
    except FileRejectedError as exc:
        raise unsupported_media_type(str(exc)) from exc
    file_id = uuid4()
    key = file_key(owner_id, session_id, file_id)
    row = (
        (
            await conn.execute(
                insert(t.agent_files)
                .values(
                    id=file_id,
                    owner_id=owner_id,
                    session_id=session_id,
                    direction="input",
                    name=filename,
                    media_type=extracted.media_type,
                    size_bytes=len(data),
                    storage_key=key,
                    text_content=extracted.text,
                )
                .returning(*_FILE_COLUMNS)
            )
        )
        .mappings()
        .one()
    )
    # Dentro da transação: se o bucket falha, a linha não fica.
    await storage.put_object(key, data, extracted.media_type)
    return file_json(row)


async def delete_input_file(conn: AsyncConnection, session_id: UUID, file_id: UUID) -> None:
    """Tira um anexo ainda não enviado; o que já foi com uma pergunta fica no histórico (409)."""
    stmt = select(F.message_id, F.direction).where(and_(F.id == file_id, F.session_id == session_id))
    row = (await conn.execute(stmt)).mappings().first()
    if row is None or row["direction"] != "input":
        raise not_found("Anexo inexistente ou de outra conta.")
    if row["message_id"] is not None:
        raise conflict("O anexo já foi enviado com uma pergunta e fica no histórico.")
    await conn.execute(delete(t.agent_files).where(F.id == file_id))


async def file_for_download(conn: AsyncConnection, file_id: UUID) -> Row:
    """O nome, o tipo e a chave de um arquivo da conta, ou 404."""
    row = (
        (await conn.execute(select(F.name, F.media_type, F.storage_key, F.size_bytes).where(F.id == file_id)))
        .mappings()
        .first()
    )
    if row is None:
        raise not_found("Arquivo inexistente ou de outra conta.")
    return row


# --- a pergunta ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Turn:
    """A pergunta e a resposta na fila, e o que o job precisa."""

    question: dict[str, Any]
    answer: dict[str, Any]
    answer_id: UUID


async def send_message(
    conn: AsyncConnection,
    owner_id: UUID,
    session_id: UUID,
    message: str,
    attachments: list[UUID],
) -> Turn:
    """Grava a pergunta com os anexos e a resposta `queued`; quem chama enfileira depois do commit.

    409 com outra resposta em aberto na conversa, 429 com `MAX_OPEN` na conta, 422 em anexo que não é
    desta conversa ou já foi enviado.
    """
    session = await _session(conn, session_id, lock=True)
    await expire_stale(conn)
    open_rows = (
        await conn.execute(select(M.session_id).where(and_(M.role == "assistant", M.status.in_(OPEN))))
    ).all()
    if any(row.session_id == session_id for row in open_rows):
        raise conflict("Esta conversa já tem uma resposta em andamento; espere ela terminar.")
    if len(open_rows) >= MAX_OPEN:
        raise rate_limited(f"Já há {MAX_OPEN} perguntas em andamento; espere uma terminar.")
    wanted = list(dict.fromkeys(attachments))
    if len(wanted) > MAX_INPUTS_PER_MESSAGE:
        raise invalid_field("attachments", f"até {MAX_INPUTS_PER_MESSAGE} anexos por pergunta")
    if wanted:
        found = (
            await conn.execute(
                select(F.id).where(
                    and_(
                        F.id.in_(wanted),
                        F.session_id == session_id,
                        F.direction == "input",
                        F.message_id.is_(None),
                    )
                )
            )
        ).scalars().all()
        if len(found) != len(wanted):
            raise invalid_field("attachments", "anexo inexistente, de outra conversa ou já enviado")
    text = message.strip()
    question = (
        (
            await conn.execute(
                insert(t.agent_messages)
                .values(session_id=session_id, owner_id=owner_id, role="user", content=text, status="done")
                .returning(t.agent_messages)
            )
        )
        .mappings()
        .one()
    )
    if wanted:
        await conn.execute(update(t.agent_files).where(F.id.in_(wanted)).values(message_id=question["id"]))
    answer = (
        (
            await conn.execute(
                insert(t.agent_messages)
                .values(session_id=session_id, owner_id=owner_id, role="assistant", status="queued")
                .returning(t.agent_messages)
            )
        )
        .mappings()
        .one()
    )
    values: dict[str, Any] = {"updated_at": func.now()}
    if not session["title"]:
        values["title"] = _title(text)
    await conn.execute(update(t.agent_sessions).where(S.id == session_id).values(**values))
    files = (
        (await conn.execute(select(*_FILE_COLUMNS).where(F.message_id == question["id"]).order_by(F.created_at)))
        .mappings()
        .all()
    )
    return Turn(
        question=message_json(question, [file_json(item) for item in files]),
        answer=message_json(answer, []),
        answer_id=answer["id"],
    )


async def enqueue_turn(redis: ArqRedis, message_id: UUID, *, transcripts: bool) -> None:
    """Enfileira `agent_turn` (depois do commit, para o job enxergar as linhas)."""
    await redis.enqueue_job(
        "agent_turn", str(message_id), transcripts, _job_id=f"agent:{message_id}", _queue_name=AGENT_QUEUE
    )


# --- o job `agent_turn` --------------------------------------------------------------------------


@dataclass(frozen=True)
class SessionEnv:
    """`agents.agent_tools.AgentEnv` sobre o banco: a base e os anexos desta conversa, como o dono."""

    engine: AsyncEngine
    owner_id: UUID
    session_id: UUID

    @property
    def base(self) -> BaseTools:
        """A base de gravações do dono."""
        return BaseTools(self.engine, self.owner_id)

    async def read_file(self, file_id: UUID) -> InputFile | None:
        """Um anexo enviado nesta conversa."""
        stmt = select(F.name, F.text_content).where(
            and_(
                F.id == file_id,
                F.session_id == self.session_id,
                F.direction == "input",
                F.message_id.is_not(None),
            )
        )
        async with user_tx(self.engine, self.owner_id) as conn:
            row = (await conn.execute(stmt)).first()
        return InputFile(file_id, row.name, row.text_content or "") if row else None


async def _context(conn: AsyncConnection, session_id: UUID, answer: Row, *, transcripts: bool) -> AgentContext:
    rows = (
        (
            await conn.execute(
                select(M.role, M.content)
                .where(and_(M.session_id == session_id, M.status == "done", M.created_at < answer["created_at"]))
                .order_by(M.created_at.desc(), M.id.desc())
                .limit(HISTORY + 1)
            )
        )
        .all()
    )
    turns = [(row.role, row.content) for row in reversed(rows)]
    if not turns or turns[-1][0] != "user":
        raise ChatError(INTERNAL_ERROR, "A pergunta desta resposta sumiu.")
    files = (
        await conn.execute(
            select(F.id, F.name, func.coalesce(func.char_length(F.text_content), 0).label("chars"))
            .where(and_(F.session_id == session_id, F.direction == "input", F.message_id.is_not(None)))
            .order_by(F.created_at)
        )
    ).all()
    return AgentContext(
        history=turns[:-1][-HISTORY:],
        question=turns[-1][1],
        files=[AttachedFile(row.id, row.name, row.chars) for row in files],
        transcripts=transcripts,
    )


async def _answer(ctx: dict[str, Any], owner_id: UUID, answer: Row, *, transcripts: bool) -> None:
    engine: AsyncEngine = ctx["engine"]
    storage: Storage = ctx["storage"]
    session_id = answer["session_id"]
    async with user_tx(engine, owner_id) as conn:
        context = await _context(conn, session_id, answer, transcripts=transcripts)
    provider = await chat_provider(ctx)
    result = await run_agent(provider, context, SessionEnv(engine, owner_id, session_id))
    rendered = [await asyncio.to_thread(render_output, item.name, item.format, item.content) for item in result.files]
    async with user_tx(engine, owner_id) as conn:
        for item in rendered:
            file_id = uuid4()
            key = file_key(owner_id, session_id, file_id)
            await conn.execute(
                insert(t.agent_files).values(
                    id=file_id,
                    owner_id=owner_id,
                    session_id=session_id,
                    message_id=answer["id"],
                    direction="output",
                    name=item.name,
                    media_type=item.media_type,
                    size_bytes=len(item.data),
                    storage_key=key,
                )
            )
            await storage.put_object(key, item.data, item.media_type)
        await conn.execute(
            update(t.agent_messages)
            .where(M.id == answer["id"])
            .values(
                status="done",
                content=result.message,
                sources=[{"recording_id": str(rid), "title": title} for rid, title in result.sources],
                queries=len(result.calls),
                model=result.completion.model if result.completion else None,
            )
        )
        await conn.execute(update(t.agent_sessions).where(S.id == session_id).values(updated_at=func.now()))


async def run_agent_turn_job(
    ctx: dict[str, Any],
    message_id: str,
    transcripts: bool = True,  # noqa: FBT001, FBT002 — argumento posicional do job
) -> str:
    """O job `agent_turn`: responde a pergunta e grava a resposta (ou o erro) na conversa."""
    engine: AsyncEngine = ctx["engine"]
    async with system_tx(engine) as conn:
        found = (await conn.execute(select(M.owner_id).where(M.id == UUID(message_id)))).first()
    if found is None:
        return "resposta sumiu (conversa excluída)"
    owner_id = found.owner_id
    async with user_tx(engine, owner_id) as conn:
        answer = (
            (
                await conn.execute(
                    update(t.agent_messages)
                    .where(and_(M.id == UUID(message_id), M.status == "queued"))
                    .values(status="running")
                    .returning(t.agent_messages)
                )
            )
            .mappings()
            .first()
        )
    if answer is None:
        return "resposta fora da fila"
    try:
        async with asyncio.timeout(CHAT_TIMEOUT_S):
            await _answer(ctx, owner_id, answer, transcripts=transcripts)
    except (ChatError, ProviderError) as exc:
        error = {"code": exc.code, "message": exc.message}
    except TimeoutError:
        error = {"code": "provider_timeout", "message": "A resposta passou do tempo limite."}
    except Exception as exc:
        log.exception("agente %s: falha inesperada", message_id)
        error = {"code": INTERNAL_ERROR, "message": type(exc).__name__}
    else:
        return "done"
    async with user_tx(engine, owner_id) as conn:
        await conn.execute(
            update(t.agent_messages).where(M.id == answer["id"]).values(status="failed", error=error)
        )
    return f"falhou: {error['code']}"


__all__ = [
    "add_input_file",
    "create_session",
    "delete_input_file",
    "delete_session",
    "enqueue_turn",
    "file_for_download",
    "list_sessions",
    "read_message",
    "rename_session",
    "run_agent_turn_job",
    "send_message",
    "session_detail",
]
