"""Previews: test a field's rule and the effect of an agenda type without writing anything.

The state lives in Redis (`eclume:preview:{id}`, a hash with `owner_id`, `kind`, `status`, `request`,
`result` and `error`) for 1 h; the CPU worker's `run_preview` job fills it. Nothing goes to the database.
Each account has at most `MAX_OPEN` open (`eclume:preview:open:{owner_id}`); beyond that, 429.
Contract in docs/standards/code/processamento-automatico.md.
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
from eclume_server.locale import job_locale
from eclume_server.problems import rate_limited
from eclume_server.queue import AGENT_QUEUE
from eclume_server.quotas import refunding, take_agent_request
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
# Open previews (queued or running) per account: each one occupies the agent.
MAX_OPEN = 3
_OPEN = {"queued", "running"}
NO_PROVIDER = "no_provider"
log = logging.getLogger(__name__)


def preview_key(preview_id: UUID | str) -> str:
    """Hash of the preview state."""
    return f"eclume:preview:{preview_id}"


def open_key(owner_id: UUID | str) -> str:
    """Sorted set (by request instant) of the account's open previews."""
    return f"eclume:preview:open:{owner_id}"


async def _open_count(redis: ArqRedis, owner_id: UUID) -> int:
    """How many the account has open, removing from the set those that finished or expired."""
    key = open_key(owner_id)
    await redis.zremrangebyscore(key, "-inf", time.time() - TTL_S)
    for member in await redis.zrange(key, 0, -1):
        preview_id = member.decode() if isinstance(member, bytes) else member
        status = await redis.hget(preview_key(preview_id), "status")
        if (status.decode() if isinstance(status, bytes) else status) not in _OPEN:
            await redis.zrem(key, preview_id)
    return await redis.zcard(key)


async def create_preview(
    redis: ArqRedis, owner_id: UUID, kind: str, request: dict[str, Any], *, agent_quota: int | None
) -> dict[str, Any]:
    """Guarda o pedido e enfileira `run_preview`; devolve o schema `Preview` na fila.

    Com `MAX_OPEN` em aberto, 429 `rate_limited`; o pedido conta na cota `agent_quota` de 24 h (403
    `quota_exceeded`).
    """
    if await _open_count(redis, owner_id) >= MAX_OPEN:
        raise rate_limited(f"There are already {MAX_OPEN} previews in progress; wait for one to finish.")
    async with refunding(redis, owner_id) as charge:
        charge.token = await take_agent_request(redis, owner_id, agent_quota)
        preview_id = uuid4()
        key = preview_key(preview_id)
        await redis.hset(
            key,
            mapping={"owner_id": str(owner_id), "kind": kind, "status": "queued", "request": json.dumps(request)},
        )
        await redis.expire(key, TTL_S)
        await redis.zadd(open_key(owner_id), {str(preview_id): time.time()})
        await redis.expire(open_key(owner_id), TTL_S)
        await redis.enqueue_job(
            "run_preview", str(preview_id), _job_id=f"preview:{preview_id}", _queue_name=AGENT_QUEUE
        )
    return {"id": str(preview_id), "kind": kind, "status": "queued", "items": [], "error": None}


def _decode(raw: dict[Any, Any]) -> dict[str, str]:
    return {
        (k.decode() if isinstance(k, bytes) else k): (v.decode() if isinstance(v, bytes) else v) for k, v in raw.items()
    }


async def get_preview(redis: ArqRedis, preview_id: UUID, owner_id: UUID) -> dict[str, Any] | None:
    """Schema `Preview`, if it exists and belongs to the user."""
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
    """A failure that becomes `Preview.error`."""

    def __init__(self, code: str, message: str) -> None:
        """Code and readable message."""
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
    """The requested transcribed recordings of the user, or the most recent ones."""
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
        locale = await job_locale(conn, owner_id)
    items = []
    for row, transcript in zip(recordings, transcripts, strict=True):
        values, _ = await extract_fields(provider, [field], None, transcript, locale=locale)
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
        locale = await job_locale(conn, owner_id)
        transcript = await transcript_text(conn, recording["transcript_id"])
    # The draft takes the place of the saved type it edits (or the one with the same name), or goes at the
    # end of the list. The fallback type does not compete: it stays when none fits or confidence is low,
    # as in detection.
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
    summary = await summarize(summarizer, transcript, draft["summary_instructions"], locale=locale)
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
        log.exception("preview %s: unexpected failure", preview_id)
        error = {"code": INTERNAL_ERROR, "message": type(exc).__name__}
    else:
        await redis.hset(key, mapping={"status": "done", "result": json.dumps(items, ensure_ascii=False)})
        await redis.zrem(open_key(state["owner_id"]), preview_id)
        return "done"
    await redis.hset(key, mapping={"status": "failed", "error": json.dumps(error, ensure_ascii=False)})
    await redis.zrem(open_key(state["owner_id"]), preview_id)
    return f"falhou: {error['code']}"
