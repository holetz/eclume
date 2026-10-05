"""As ações do Agente no ambiente: a proposta, a confirmação, a execução e o registro de auditoria.

O agente só propõe (`agents/agent_tools.py`): `Planner` resolve os alvos sob a RLS do dono e escreve
o resumo do cartão; o job `agent_turn` grava a proposta em `agent_actions` (`proposed`). A pessoa
confirma (`proposed → queued`, uma atualização condicional: confirmar de novo não reenfileira) e o
job `agent_action` executa alvo a alvo pelas funções de `operations.py` — as mesmas do MCP —, cada
alvo numa transação que faz a operação e grava o resultado dele, então uma nova execução pula o que
já foi feito. A linha fica como auditoria, mesmo depois que a conversa sai. Contrato em
docs/standards/code/server-agentes.md §Agente.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import and_, func, insert, or_, select, tuple_, update

from eclume_server.agents.agent_tools import ACTION_SCOPES, ProposedAction
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx, user_tx
from eclume_server.operations import change_agenda_type, edit_collections, edit_tags, regenerate_summary
from eclume_server.pagination import decode_cursor, encode_cursor, iso
from eclume_server.problems import ApiProblemError, conflict, insufficient_scope, not_found
from eclume_server.queue import AGENT_QUEUE, enqueue_summary
from eclume_server.recordings import Library
from eclume_server.summaries import TRANSCRIPT_MISSING

if TYPE_CHECKING:
    from arq.connections import ArqRedis
    from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

    from eclume_server.auth import Principal
    from eclume_server.serialize import Row

PROPOSAL_TTL = timedelta(hours=24)
RETRY_DEFER_S = 30
MAX_RETRIES = 120
FINAL = ("done", "failed", "cancelled", "expired")
log = logging.getLogger(__name__)

A = t.agent_actions.c
R = t.recordings.c


# --- vistas --------------------------------------------------------------------------------------


def action_json(row: Row) -> dict[str, Any]:
    """Schema `AgentAction`: a proposta, o estado e o resultado por alvo."""
    results: dict[str, Any] = row["results"] or {}
    counts = {"done": 0, "skipped": 0, "failed": 0}
    for outcome in results.values():
        counts[outcome["status"]] = counts.get(outcome["status"], 0) + 1
    targets = row["targets"] or []
    return {
        "id": str(row["id"]),
        "session_id": str(row["session_id"]) if row["session_id"] else None,
        "message_id": str(row["message_id"]) if row["message_id"] else None,
        "tool": row["tool"],
        "params": row["params"],
        "summary": row["summary"],
        "targets": [{**item, "result": results.get(item["recording_id"])} for item in targets],
        "status": row["status"],
        "counts": {**counts, "pending": max(len(targets) - len(results), 0)},
        "error": row["error"],
        "confirmed_via": row["confirmed_via"],
        "created_at": iso(row["created_at"]),
        "decided_at": iso(row["decided_at"]) if row["decided_at"] else None,
        "finished_at": iso(row["finished_at"]) if row["finished_at"] else None,
    }


# --- a proposta ----------------------------------------------------------------------------------


def _uuid(value: str) -> UUID | None:
    try:
        return UUID(value)
    except ValueError:
        return None


async def _by_name(conn: AsyncConnection, table: Any, value: str) -> Row | None:  # noqa: ANN401 — a tabela
    """Um tipo de agenda ou uma coleção do dono, pelo id ou pelo nome (sem caixa)."""
    rid = _uuid(value)
    condition = table.c.id == rid if rid is not None else func.lower(table.c.name) == value.lower()
    return (await conn.execute(select(table.c.id, table.c.name).where(condition).limit(1))).mappings().first()


def _plural(count: int, one: str, many: str) -> str:
    return f"{count} {one if count == 1 else many}"


class PlanError(Exception):
    """O motivo, para o agente, de não haver proposta."""


class Planner:
    """Resolve os alvos e escreve o resumo de uma proposta, sob a RLS do dono."""

    def __init__(self, engine: AsyncEngine, owner_id: UUID) -> None:
        """O planejador das propostas de uma conta."""
        self.engine = engine
        self.owner_id = owner_id

    async def plan(self, tool: str, params: dict[str, Any], limit: int) -> ProposedAction | str:
        """A proposta, ou o motivo (texto) quando não há alvo, um nome não existe ou passa do limite."""
        try:
            async with user_tx(self.engine, self.owner_id) as conn:
                extra = await self._resolve(conn, tool, params)
                targets = await self._targets(conn, tool, params["targets"], limit)
        except PlanError as exc:
            return str(exc)
        normalized = {**params, **extra}
        return ProposedAction(tool, normalized, _summary(tool, normalized, len(targets)), targets)

    async def _resolve(self, conn: AsyncConnection, tool: str, params: dict[str, Any]) -> dict[str, Any]:
        if tool == "collect_recordings":
            resolved: dict[str, Any] = {}
            for key in ("add", "remove"):
                found = []
                for value in params[key]:
                    row = await _by_name(conn, t.collections, value)
                    if row is None:
                        raise PlanError(f'a coleção "{value}" não existe; o agente não cria coleções')
                    found.append({"id": str(row["id"]), "name": row["name"]})
                resolved[key] = found
            return resolved
        if tool == "set_agenda_type":
            row = await _by_name(conn, t.agenda_types, params["agenda_type"])
            if row is None:
                raise PlanError(f'o tipo de agenda "{params["agenda_type"]}" não existe')
            return {"agenda_type": {"id": str(row["id"]), "name": row["name"]}}
        return {}

    async def _targets(
        self, conn: AsyncConnection, tool: str, targets: dict[str, Any], limit: int
    ) -> list[tuple[UUID, str]]:
        if "recording_ids" in targets:
            conditions = [R.id.in_([UUID(item) for item in targets["recording_ids"]])]
        else:
            conditions = await self._filter(conn, targets)
        if tool == "regenerate_summaries":
            conditions.append(R.status == "transcribed")
        stmt = select(R.id, R.title).where(*conditions).order_by(R.recorded_at.desc(), R.id.desc()).limit(limit + 1)
        rows = (await conn.execute(stmt)).all()
        if not rows:
            raise PlanError("nenhuma gravação (transcrita, para resumos) corresponde aos alvos")
        if len(rows) > limit:
            total = (await conn.execute(select(func.count()).select_from(t.recordings).where(*conditions))).scalar_one()
            raise PlanError(
                f"os alvos somam {total} gravações, acima do limite de {limit} desta ação; estreite o pedido "
                "(período, tipo, coleção ou tag) ou divida em partes"
            )
        return [(row.id, row.title or "Sem título") for row in rows]

    async def _filter(self, conn: AsyncConnection, targets: dict[str, Any]) -> list[Any]:
        agenda_type = collection = None
        if "agenda_type" in targets:
            row = await _by_name(conn, t.agenda_types, targets["agenda_type"])
            if row is None:
                raise PlanError(f'o tipo de agenda "{targets["agenda_type"]}" não existe')
            agenda_type = [row["id"]]
        if "collection" in targets:
            row = await _by_name(conn, t.collections, targets["collection"])
            if row is None:
                raise PlanError(f'a coleção "{targets["collection"]}" não existe')
            collection = [row["id"]]
        start = _day(targets.get("from"))
        end = _day(targets.get("to"))
        library = Library(
            since=None,
            from_=start,
            # `to` é o último dia, inclusive.
            to=end + timedelta(days=1) if end else None,
            kind=None,
            status=None,
            tag=[targets["tag"]] if "tag" in targets else None,
            collection=collection,
            person=None,
            agenda_type=agenda_type,
        )
        return library.filters()


def _day(value: str | None) -> datetime | None:
    if value is None:
        return None
    return datetime.combine(date.fromisoformat(value), datetime.min.time(), tzinfo=UTC)


def _summary(tool: str, params: dict[str, Any], count: int) -> str:
    """O texto do cartão de confirmação."""
    recordings = _plural(count, "gravação", "gravações")
    if tool == "regenerate_summaries":
        return f"Gerar de novo o resumo de {recordings}, pelas instruções do tipo de agenda de cada uma."
    if tool == "tag_recordings":
        parts = []
        if params["add"]:
            parts.append("aplicar " + ", ".join(f'"{tag}"' for tag in params["add"]))
        if params["remove"]:
            parts.append("remover " + ", ".join(f'"{tag}"' for tag in params["remove"]))
        return f"Nas tags de {recordings}: {' e '.join(parts)}."
    if tool == "collect_recordings":
        parts = []
        if params["add"]:
            parts.append("incluir em " + ", ".join(f'"{item["name"]}"' for item in params["add"]))
        if params["remove"]:
            parts.append("tirar de " + ", ".join(f'"{item["name"]}"' for item in params["remove"]))
        return f"Coleções de {recordings}: {' e '.join(parts)}."
    return f'Trocar o tipo de agenda de {recordings} para "{params["agenda_type"]["name"]}" (abre um resumo novo).'


async def save_proposals(
    conn: AsyncConnection, owner_id: UUID, session_id: UUID, message_id: UUID, proposals: list[ProposedAction]
) -> None:
    """Grava as propostas da resposta em `proposed`, com os alvos congelados."""
    for item in proposals:
        await conn.execute(
            insert(t.agent_actions).values(
                owner_id=owner_id,
                session_id=session_id,
                message_id=message_id,
                tool=item.tool,
                params=item.params,
                summary=item.summary,
                targets=[{"recording_id": str(rid), "title": title} for rid, title in item.targets],
            )
        )


async def actions_by_message(conn: AsyncConnection, message_ids: list[UUID]) -> dict[UUID, list[dict[str, Any]]]:
    """As propostas de cada resposta, na ordem."""
    if not message_ids:
        return {}
    await expire_proposals(conn)
    rows = (
        (await conn.execute(select(t.agent_actions).where(A.message_id.in_(message_ids)).order_by(A.created_at, A.id)))
        .mappings()
        .all()
    )
    found: dict[UUID, list[dict[str, Any]]] = {}
    for row in rows:
        found.setdefault(row["message_id"], []).append(action_json(row))
    return found


# --- confirmar, descartar, ler -------------------------------------------------------------------


async def expire_proposals(conn: AsyncConnection) -> None:
    """As propostas do dono com mais de `PROPOSAL_TTL` viram `expired`."""
    await conn.execute(
        update(t.agent_actions)
        .where(and_(A.status == "proposed", A.created_at < func.now() - PROPOSAL_TTL))
        .values(status="expired", decided_at=func.now())
    )


async def _action(conn: AsyncConnection, action_id: UUID, *, lock: bool = False) -> Row:
    await expire_proposals(conn)
    stmt = select(t.agent_actions).where(A.id == action_id)
    if lock:
        stmt = stmt.with_for_update()
    row = (await conn.execute(stmt)).mappings().first()
    if row is None:
        raise not_found("Ação inexistente ou sem acesso.")
    return row


async def read_action(conn: AsyncConnection, action_id: UUID) -> dict[str, Any]:
    """Uma ação da conta."""
    return action_json(await _action(conn, action_id))


async def list_actions(conn: AsyncConnection, cursor: str | None, limit: int) -> dict[str, Any]:
    """O registro de auditoria: as ações da conta, da mais recente para trás."""
    await expire_proposals(conn)
    stmt = select(t.agent_actions).order_by(A.created_at.desc(), A.id.desc()).limit(limit + 1)
    if cursor:
        stmt = stmt.where(tuple_(A.created_at, A.id) < decode_cursor(cursor))
    rows = (await conn.execute(stmt)).mappings().all()
    last = rows[limit - 1] if len(rows) > limit else None
    return {
        "items": [action_json(row) for row in rows[:limit]],
        "next_cursor": encode_cursor(last["created_at"], last["id"]) if last else None,
    }


async def confirm_action(conn: AsyncConnection, principal: Principal, action_id: UUID) -> tuple[dict[str, Any], bool]:
    """`proposed → queued`; devolve a ação e se é preciso enfileirar.

    Já confirmada (ou terminada), devolve o estado atual sem reenfileirar: confirmar é idempotente.
    Vencida ou descartada, 409. PAT sem o escopo da ferramenta, 403.
    """
    row = await _action(conn, action_id, lock=True)
    scope = ACTION_SCOPES[row["tool"]]
    if principal.method == "pat" and scope not in principal.scopes:
        raise insufficient_scope([scope])
    if row["status"] in {"expired", "cancelled"}:
        raise conflict(
            "Esta proposta venceu ou foi descartada; peça de novo ao Agente.", code=f"action_{row['status']}"
        )
    if row["status"] != "proposed":
        return action_json(row), False
    updated = (
        (
            await conn.execute(
                update(t.agent_actions)
                .where(and_(A.id == action_id, A.status == "proposed"))
                .values(
                    status="queued",
                    decided_at=func.now(),
                    confirmed_via=principal.method if principal.method in {"session", "pat"} else "session",
                    token_id=principal.token_id,
                )
                .returning(t.agent_actions)
            )
        )
        .mappings()
        .one()
    )
    return action_json(updated), True


async def cancel_action(conn: AsyncConnection, action_id: UUID) -> dict[str, Any]:
    """Descarta a proposta; só de `proposed` (senão 409)."""
    row = await _action(conn, action_id, lock=True)
    if row["status"] == "cancelled":
        return action_json(row)
    if row["status"] != "proposed":
        raise conflict("Só uma proposta ainda não confirmada pode ser descartada.", code="action_not_proposed")
    updated = (
        (
            await conn.execute(
                update(t.agent_actions)
                .where(A.id == action_id)
                .values(status="cancelled", decided_at=func.now())
                .returning(t.agent_actions)
            )
        )
        .mappings()
        .one()
    )
    return action_json(updated)


async def enqueue_action(redis: ArqRedis, action_id: UUID, attempt: int = 0) -> None:
    """Enfileira `agent_action` (depois do commit); o id do job deduplica a confirmação repetida."""
    suffix = f":{attempt}" if attempt else ""
    await redis.enqueue_job(
        "agent_action",
        str(action_id),
        attempt,
        _job_id=f"agent_action:{action_id}{suffix}",
        _queue_name=AGENT_QUEUE,
        _defer_by=timedelta(seconds=RETRY_DEFER_S) if attempt else None,
    )


# --- o job `agent_action` ------------------------------------------------------------------------


class _Retry(Exception):  # noqa: N818 — sinal interno, não erro
    """Os resumos em aberto estão no teto: o job volta em `RETRY_DEFER_S`."""


async def _record(conn: AsyncConnection, action_id: UUID, rid: str, outcome: dict[str, Any]) -> None:
    current = (
        await conn.execute(select(A.results).where(A.id == action_id).with_for_update())
    ).scalar_one()
    await conn.execute(update(t.agent_actions).where(A.id == action_id).values(results={**current, rid: outcome}))


async def _apply(
    conn: AsyncConnection, redis: ArqRedis, owner_id: UUID, row: Row, rid: UUID
) -> tuple[dict[str, Any], UUID | None]:
    """Executa a ação num alvo; devolve o resultado e o resumo a enfileirar."""
    params, tool = row["params"], row["tool"]
    current = (await conn.execute(select(R.id, R.agenda_type_id).where(R.id == rid))).first()
    if current is None:
        return {"status": "skipped", "detail": "gravação inexistente ou excluída"}, None
    if tool == "regenerate_summaries":
        summary_id = await regenerate_summary(conn, redis, owner_id, rid)
        return {"status": "done", "summary_id": str(summary_id)}, summary_id
    if tool == "tag_recordings":
        changed = await edit_tags(conn, owner_id, rid, add=params["add"], remove=params["remove"])
        unchanged = {"status": "skipped", "detail": "as tags já estavam assim"}
        return ({"status": "done"} if changed else unchanged), None
    if tool == "collect_recordings":
        add = [UUID(item["id"]) for item in params["add"]]
        remove = [UUID(item["id"]) for item in params["remove"]]
        changed = await edit_collections(conn, rid, add=add, remove=remove)
        unchanged = {"status": "skipped", "detail": "as coleções já estavam assim"}
        return ({"status": "done"} if changed else unchanged), None
    agenda_type_id = UUID(params["agenda_type"]["id"])
    if current.agenda_type_id == agenda_type_id:
        return {"status": "skipped", "detail": "já era deste tipo"}, None
    summary_id = await change_agenda_type(conn, rid, agenda_type_id)
    return {"status": "done", "summary_id": str(summary_id) if summary_id else None}, summary_id


async def _one(ctx: dict[str, Any], owner_id: UUID, row: Row, rid: str) -> bool:
    """Um alvo numa transação (a operação e o resultado juntos); `False` encerra o resto (cota)."""
    engine: AsyncEngine = ctx["engine"]
    redis: ArqRedis = ctx["redis"]
    try:
        async with user_tx(engine, owner_id) as conn:
            outcome, summary_id = await _apply(conn, redis, owner_id, row, UUID(rid))
            await _record(conn, row["id"], rid, outcome)
    except ApiProblemError as exc:
        if exc.status_code == 429:  # noqa: PLR2004 — os resumos em aberto no teto
            raise _Retry from exc
        if exc.code == TRANSCRIPT_MISSING:
            outcome = {"status": "skipped", "detail": "a gravação ainda não tem transcrição"}
        else:
            outcome = {"status": "failed", "code": exc.code, "detail": exc.detail or exc.code}
        async with user_tx(engine, owner_id) as conn:
            await _record(conn, row["id"], rid, outcome)
        return exc.code != "quota_exceeded"
    if summary_id is not None:
        await enqueue_summary(redis, summary_id)
    return True


async def _finish(engine: AsyncEngine, owner_id: UUID, action_id: UUID, **values: Any) -> None:  # noqa: ANN401
    async with user_tx(engine, owner_id) as conn:
        await conn.execute(update(t.agent_actions).where(A.id == action_id).values(**values, finished_at=func.now()))


async def run_agent_action_job(ctx: dict[str, Any], action_id: str, attempt: int = 0) -> str:
    """O job `agent_action`: executa a ação confirmada, alvo a alvo, até `done`."""
    engine: AsyncEngine = ctx["engine"]
    aid = UUID(action_id)
    async with system_tx(engine) as conn:
        found = (await conn.execute(select(A.owner_id).where(A.id == aid))).first()
    if found is None:
        return "ação sumiu"
    owner_id = found.owner_id
    async with user_tx(engine, owner_id) as conn:
        row = (
            (
                await conn.execute(
                    update(t.agent_actions)
                    .where(and_(A.id == aid, or_(A.status == "queued", A.status == "running")))
                    .values(status="running")
                    .returning(t.agent_actions)
                )
            )
            .mappings()
            .first()
        )
    if row is None:
        return "ação fora da fila"
    pending = [item["recording_id"] for item in row["targets"] if item["recording_id"] not in (row["results"] or {})]
    try:
        for index, rid in enumerate(pending):
            if not await _one(ctx, owner_id, row, rid):
                rest = pending[index + 1 :]
                skipped = {"status": "failed", "code": "quota_exceeded", "detail": "cota de 24 h do agente esgotada"}
                async with user_tx(engine, owner_id) as conn:
                    for other in rest:
                        await _record(conn, aid, other, skipped)
                break
    except _Retry:
        if attempt >= MAX_RETRIES:
            error = {"code": "rate_limited", "message": "Os resumos em aberto não liberaram a tempo."}
            await _finish(engine, owner_id, aid, status="failed", error=error)
            return "falhou: rate_limited"
        await enqueue_action(ctx["redis"], aid, attempt + 1)
        return "reagendada: resumos em aberto no teto"
    except Exception as exc:
        log.exception("ação %s: falha inesperada", action_id)
        error = {"code": "internal_error", "message": type(exc).__name__}
        await _finish(engine, owner_id, aid, status="failed", error=error)
        return "falhou: internal_error"
    await _finish(engine, owner_id, aid, status="done")
    return "done"


__all__ = [
    "Planner",
    "action_json",
    "actions_by_message",
    "cancel_action",
    "confirm_action",
    "enqueue_action",
    "list_actions",
    "read_action",
    "run_agent_action_job",
    "save_proposals",
]
