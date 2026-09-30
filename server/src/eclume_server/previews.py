"""Pré-visualizações: testar a regra de um campo e o efeito de um tipo de agenda sem gravar nada.

O estado vive no Redis (`eclume:preview:{id}`, hash com `owner_id`, `kind`, `status`, `request`,
`result` e `error`) por 1 h; o job `run_preview` do worker CPU o preenche. Nada vai para o banco.
Cada conta tem no máximo `MAX_OPEN` em aberto (`eclume:preview:open:{owner_id}`); além disso, 429.
Contrato em docs/standards/code/processamento-automatico.md.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

from sqlalchemy import select

from eclume_server.agenda_types import render_title, title_values
from eclume_server.agents import ProviderError
from eclume_server.agents.extraction import MIN_CONFIDENCE, FieldSpec, TypeSpec, detect_type, extract_fields
from eclume_server.agents.prompting import summarize
from eclume_server.crypto import SecretDecryptError
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.problems import rate_limited
from eclume_server.queue import DEFAULT_QUEUE
from eclume_server.summaries import (
    INTERNAL_ERROR,
    JOB_TIMEOUT_S,
    load_provider,
    provider_config,
    provider_factory,
    provider_for,
    transcript_text,
)

if TYPE_CHECKING:
    from arq.connections import ArqRedis
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.agents import Provider
    from eclume_server.serialize import Row

TTL_S = 3600
MAX_RECORDINGS = 3
# Pré-visualizações em aberto (na fila ou rodando) por conta: cada uma ocupa o agente.
MAX_OPEN = 3
_OPEN = {"queued", "running"}
NO_PROVIDER = "no_provider"
log = logging.getLogger(__name__)


def preview_key(preview_id: UUID | str) -> str:
    """Hash do estado da pré-visualização."""
    return f"eclume:preview:{preview_id}"


def open_key(owner_id: UUID | str) -> str:
    """Conjunto ordenado (pelo instante do pedido) das pré-visualizações em aberto da conta."""
    return f"eclume:preview:open:{owner_id}"


async def _open_count(redis: ArqRedis, owner_id: UUID) -> int:
    """Quantas a conta tem em aberto, tirando do conjunto as que terminaram ou expiraram."""
    key = open_key(owner_id)
    await redis.zremrangebyscore(key, "-inf", time.time() - TTL_S)
    for member in await redis.zrange(key, 0, -1):
        preview_id = member.decode() if isinstance(member, bytes) else member
        status = await redis.hget(preview_key(preview_id), "status")
        if (status.decode() if isinstance(status, bytes) else status) not in _OPEN:
            await redis.zrem(key, preview_id)
    return await redis.zcard(key)


async def create_preview(redis: ArqRedis, owner_id: UUID, kind: str, request: dict[str, Any]) -> dict[str, Any]:
    """Guarda o pedido e enfileira `run_preview`; devolve o schema `Preview` na fila.

    Com `MAX_OPEN` em aberto, 429 `rate_limited`.
    """
    if await _open_count(redis, owner_id) >= MAX_OPEN:
        raise rate_limited(f"Já há {MAX_OPEN} pré-visualizações em andamento; espere uma terminar.")
    preview_id = uuid4()
    key = preview_key(preview_id)
    await redis.hset(
        key,
        mapping={"owner_id": str(owner_id), "kind": kind, "status": "queued", "request": json.dumps(request)},
    )
    await redis.expire(key, TTL_S)
    await redis.zadd(open_key(owner_id), {str(preview_id): time.time()})
    await redis.expire(open_key(owner_id), TTL_S)
    await redis.enqueue_job("run_preview", str(preview_id), _job_id=f"preview:{preview_id}", _queue_name=DEFAULT_QUEUE)
    return {"id": str(preview_id), "kind": kind, "status": "queued", "items": [], "error": None}


def _decode(raw: dict[Any, Any]) -> dict[str, str]:
    return {
        (k.decode() if isinstance(k, bytes) else k): (v.decode() if isinstance(v, bytes) else v) for k, v in raw.items()
    }


async def get_preview(redis: ArqRedis, preview_id: UUID, owner_id: UUID) -> dict[str, Any] | None:
    """Schema `Preview`, se existe e é do usuário."""
    state = _decode(await redis.hgetall(preview_key(preview_id)))
    if state.get("owner_id") != str(owner_id):
        return None
    return {
        "id": str(preview_id),
        "kind": state["kind"],
        "status": state["status"],
        "items": json.loads(state.get("result") or "[]"),
        "error": json.loads(state["error"]) if state.get("error") else None,
    }


# --- o job `run_preview` ------------------------------------------------------------------------


class PreviewError(Exception):
    """Falha que vira `Preview.error`."""

    def __init__(self, code: str, message: str) -> None:
        """Código e mensagem legível."""
        super().__init__(message)
        self.code = code
        self.message = message


async def _provider(ctx: dict[str, Any], conn: AsyncConnection, purpose: str) -> Provider:
    public = await provider_for(conn, purpose)
    if public is None:
        raise PreviewError(NO_PROVIDER, f"Nenhum provider habilitado para {purpose}.")
    row, platform_key = await load_provider(conn, public["id"])
    try:
        return provider_factory(ctx)(provider_config(ctx["settings"], row, platform_key))
    except SecretDecryptError as exc:
        raise PreviewError("provider_not_configured", "A chave de API do provider não abre.") from exc


async def _transcribed(conn: AsyncConnection, owner_id: UUID, recording_ids: list[UUID]) -> list[Row]:
    """As gravações transcritas do usuário pedidas, ou as mais recentes."""
    r = t.recordings.c
    query = (
        select(t.recordings, t.transcripts.c.id.label("transcript_id"))
        .join(t.transcripts, t.transcripts.c.recording_id == r.id)
        .where(r.owner_id == owner_id)
    )
    if recording_ids:
        query = query.where(r.id.in_(recording_ids))
    rows = (await conn.execute(query.order_by(r.recorded_at.desc(), r.id).limit(MAX_RECORDINGS))).mappings().all()
    return list(rows)


async def _field_rule(ctx: dict[str, Any], owner_id: UUID, request: dict[str, Any]) -> list[dict[str, Any]]:
    draft = request["field"]
    field = FieldSpec(
        key="campo",
        kind=draft["kind"],
        instructions=draft.get("instructions", ""),
        options=tuple(draft.get("options", [])),
    )
    async with system_tx(ctx["engine"]) as conn:
        provider = await _provider(ctx, conn, "fields")
        recordings = await _transcribed(conn, owner_id, [UUID(value) for value in request.get("recording_ids", [])])
        transcripts = [await transcript_text(conn, row["transcript_id"]) for row in recordings]
    items = []
    for row, transcript in zip(recordings, transcripts, strict=True):
        values, _ = await extract_fields(provider, [field], None, transcript)
        items.append({"recording_id": str(row["id"]), "recording_title": row["title"], "value": values["campo"]})
    return items


async def _agenda_type(ctx: dict[str, Any], owner_id: UUID, request: dict[str, Any]) -> list[dict[str, Any]]:
    draft = request["agenda_type"]
    async with system_tx(ctx["engine"]) as conn:
        detector = await _provider(ctx, conn, "agenda_detection")
        summarizer = await _provider(ctx, conn, "summaries")
        (recording,) = await _transcribed(conn, owner_id, [UUID(request["recording_id"])])
        saved = (
            (
                await conn.execute(
                    select(t.agenda_types)
                    .where(t.agenda_types.c.owner_id == owner_id)
                    .order_by(t.agenda_types.c.position, t.agenda_types.c.id)
                )
            )
            .mappings()
            .all()
        )
        values = await title_values(conn, recording, draft)
        transcript = await transcript_text(conn, recording["transcript_id"])
    # O rascunho entra no lugar do tipo salvo que edita (ou do de mesmo nome), ou no fim da lista. O tipo
    # de reserva não concorre: ele fica quando nenhum serve ou a confiança é baixa, como na detecção.
    edited = request.get("agenda_type_id")
    replaced = next(
        (row for row in saved if (str(row["id"]) == edited if edited else row["name"] == draft["name"])), None
    )
    draft_is_reserve = replaced is not None and replaced["is_fallback"]
    reserve = next((row["name"] for row in saved if row["is_fallback"]), None)
    others = [row for row in saved if not row["is_fallback"] and row is not replaced]
    types = [TypeSpec(name=row["name"], identify=row["identify"]) for row in others]
    if not draft_is_reserve:
        types.append(TypeSpec(name=draft["name"], identify=draft.get("identify", "")))
    detection = await detect_type(detector, types, transcript) if types else None
    candidate = types[detection.index].name if detection is not None and detection.index is not None else None
    unsure = detection is not None and detection.confidence is not None and detection.confidence < MIN_CONFIDENCE
    fallback = candidate is None or unsure
    reserve_name = draft["name"] if draft_is_reserve else (reserve or draft["name"])
    detected_name = reserve_name if fallback else candidate
    summary = await summarize(summarizer, transcript, draft["summary_instructions"])
    title = recording["title"]
    if draft.get("title_pattern"):
        title = render_title(draft["title_pattern"], values) or title
    return [
        {
            "recording_id": str(recording["id"]),
            "recording_title": recording["title"],
            "detected": detected_name == draft["name"],
            "detected_type_name": detected_name,
            "fallback": fallback,
            "confidence": detection.confidence if detection is not None else None,
            "title": title,
            "tags": list(dict.fromkeys([*recording["tags"], *draft.get("default_tags", [])])),
            "summary_md": summary.text,
        }
    ]


_KINDS = {"field_rule": _field_rule, "agenda_type": _agenda_type}


async def run_preview(ctx: dict[str, Any], preview_id: str) -> str:
    """O job `run_preview`: roda o rascunho e grava o resultado (ou o erro) no Redis."""
    redis: ArqRedis = ctx["redis"]
    key = preview_key(preview_id)
    state = _decode(await redis.hgetall(key))
    if not state:
        return "pré-visualização expirada"
    await redis.hset(key, "status", "running")
    try:
        async with asyncio.timeout(JOB_TIMEOUT_S):
            items = await _KINDS[state["kind"]](ctx, UUID(state["owner_id"]), json.loads(state["request"]))
    except (PreviewError, ProviderError) as exc:
        error = {"code": exc.code, "message": exc.message}
    except Exception as exc:
        log.exception("pré-visualização %s: falha inesperada", preview_id)
        error = {"code": INTERNAL_ERROR, "message": type(exc).__name__}
    else:
        await redis.hset(key, mapping={"status": "done", "result": json.dumps(items, ensure_ascii=False)})
        await redis.zrem(open_key(state["owner_id"]), preview_id)
        return "done"
    await redis.hset(key, mapping={"status": "failed", "error": json.dumps(error, ensure_ascii=False)})
    await redis.zrem(open_key(state["owner_id"]), preview_id)
    return f"falhou: {error['code']}"
