"""Resumos: configuração da plataforma, criação versionada pelo tipo de agenda e o job `summarize`.

Contrato e decisões em docs/standards/code/server-agentes.md.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from arq import Retry
from sqlalchemy import any_, func, insert, literal, select, text, update

from eclume_server.agents import ProviderConfig, ProviderError, build_provider
from eclume_server.agents.base import GPU_BUSY, PROVIDER_NOT_CONFIGURED, PROVIDER_TIMEOUT
from eclume_server.agents.prompting import TranscriptText, render_transcript, summarize
from eclume_server.crypto import SecretDecryptError, decrypt
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.pagination import iso
from eclume_server.queue import GPU_QUEUE
from eclume_server.settings_admin import ANTHROPIC_API_KEY, secret_encrypted

if TYPE_CHECKING:
    from collections.abc import Callable
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

    from eclume_server.agents import Provider
    from eclume_server.config import Settings
    from eclume_server.serialize import Row


log = logging.getLogger(__name__)


# --- providers por finalidade --------------------------------------------------------------------

# Colunas de `agent_providers` que `eclume_app` lê: a chave de API fica só para o papel de conexão.
PROVIDER_PUBLIC = [column for column in t.agent_providers.c if column.name != "api_key_encrypted"]
PURPOSES = ("summaries", "fields", "chat", "agenda_detection")


async def provider_for(conn: AsyncConnection, purpose: str) -> Row | None:
    """O provider habilitado que declara a finalidade (há no máximo um), sem a chave de API."""
    c = t.agent_providers.c
    query = select(*PROVIDER_PUBLIC).where(c.enabled, literal(purpose) == any_(c.used_for))
    return (await conn.execute(query)).mappings().first()


# --- formas JSON ------------------------------------------------------------------------------------


def summary_json(row: Row) -> dict[str, Any]:
    """Schema `Summary`, com tipo de agenda e provider em instantâneo."""
    error = None
    if row["error_code"]:
        error = {"code": row["error_code"], "message": row["error_message"] or ""}
    return {
        "id": str(row["id"]),
        "transcript_id": str(row["transcript_id"]),
        "transcript_revision": row["transcript_revision"],
        "agenda_type": {"id": str(row["agenda_type_id"]), "name": row["agenda_type_name"]},
        "version": row["version"],
        "status": row["status"],
        "trigger": row["trigger"],
        "provider": {"id": str(row["provider_id"]), "name": row["provider_name"], "kind": row["provider_kind"]},
        "model": row["model"],
        "content_md": row["content_md"] if row["status"] == "done" else None,
        "error": error,
        "created_at": iso(row["created_at"]),
        "completed_at": iso(row["completed_at"]),
    }


# --- criação -----------------------------------------------------------------------------------------


async def create_summary(  # noqa: PLR0913 — o resumo nasce de transcrição, tipo, provider e gatilho
    conn: AsyncConnection,
    *,
    transcript: Row,
    agenda_type: Row,
    provider: Row,
    trigger: str,
    created_by: UUID,
) -> Row:
    """Insere um resumo `queued` com a próxima `version` do par (transcrição, tipo de agenda).

    Serve à API (sob a RLS do dono) e ao resumo automático (papel de conexão). As instruções do
    tipo entram como instantâneo. O lock do par serializa gerações simultâneas do mesmo tipo.
    """
    s = t.summaries.c
    await conn.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:pair, 0))"),
        {"pair": f"summary:{transcript['id']}:{agenda_type['id']}"},
    )
    version = (
        await conn.execute(
            select(func.coalesce(func.max(s.version), 0) + 1).where(
                s.transcript_id == transcript["id"], s.agenda_type_id == agenda_type["id"]
            )
        )
    ).scalar_one()
    return (
        (
            await conn.execute(
                insert(t.summaries)
                .values(
                    owner_id=transcript["owner_id"],
                    transcript_id=transcript["id"],
                    transcript_revision=transcript["revision"],
                    agenda_type_id=agenda_type["id"],
                    agenda_type_name=agenda_type["name"],
                    instructions=agenda_type["summary_instructions"],
                    version=version,
                    status="queued",
                    trigger=trigger,
                    provider_id=provider["id"],
                    provider_name=provider["name"],
                    provider_kind=provider["kind"],
                    model=provider["model"],
                    created_by=created_by,
                )
                .returning(t.summaries)
            )
        )
        .mappings()
        .one()
    )


# --- resumo automático ---------------------------------------------------------------------------


async def auto_summarize(conn: AsyncConnection, recording_id: UUID) -> UUID | None:
    """Cria o resumo automático da transcrição recém-ingerida.

    Roda com o papel de conexão, na transação do `ingest_transcript`. As instruções são as do tipo de
    agenda da gravação e o provider, o que a plataforma declara para `summaries`; sem um dos dois,
    não há resumo automático. Um resumo automático por revisão da transcrição.
    """
    transcript = (
        (await conn.execute(select(t.transcripts).where(t.transcripts.c.recording_id == recording_id)))
        .mappings()
        .first()
    )
    if transcript is None:
        return None
    provider = await provider_for(conn, "summaries")
    if provider is None:
        log.info("resumo automático de %s: nenhum provider habilitado para resumos", recording_id)
        return None
    agenda_type = (
        (
            await conn.execute(
                select(t.agenda_types)
                .join(t.recordings, t.recordings.c.agenda_type_id == t.agenda_types.c.id)
                .where(t.recordings.c.id == recording_id)
            )
        )
        .mappings()
        .first()
    )
    if agenda_type is None:
        log.info("resumo automático de %s: a gravação não tem tipo de agenda", recording_id)
        return None
    s = t.summaries.c
    already = (
        await conn.execute(
            select(s.id).where(
                s.transcript_id == transcript["id"],
                s.transcript_revision == transcript["revision"],
                s.trigger == "automatic",
            )
        )
    ).first()
    if already is not None:
        return None
    row = await create_summary(
        conn,
        transcript=transcript,
        agenda_type=agenda_type,
        provider=provider,
        trigger="automatic",
        created_by=transcript["owner_id"],
    )
    return row["id"]


# --- o job `summarize` ---------------------------------------------------------------------------

MAX_ATTEMPTS = 3
RETRY_DELAYS_S = (30, 120)
GPU_RETRY_S = 60
OLLAMA_WAIT_S = 2 * 3600
# Abaixo do `timeout` do arq (30 min), para o resumo terminar `failed` e não preso em `running`.
JOB_TIMEOUT_S = 25 * 60
INTERNAL_ERROR = "internal_error"


def provider_config(settings: Settings, row: Row, platform_key_encrypted: str | None = None) -> ProviderConfig:
    """Configuração do provider com a chave decifrada; sem chave própria, vale a da plataforma."""
    encrypted = row["api_key_encrypted"] or platform_key_encrypted
    api_key = decrypt(settings, encrypted) if encrypted else None
    return ProviderConfig(
        kind=row["kind"],
        model=row["model"],
        name=row["name"],
        base_url=row["base_url"],
        api_key=api_key,
        options=dict(row["options"] or {}),
    )


async def _transcript_text(conn: AsyncConnection, transcript_id: UUID) -> TranscriptText:
    head = (
        (
            await conn.execute(
                select(t.recordings.c.title, t.recordings.c.recorded_at)
                .join(t.transcripts, t.transcripts.c.recording_id == t.recordings.c.id)
                .where(t.transcripts.c.id == transcript_id)
            )
        )
        .mappings()
        .one()
    )
    speakers = (
        await conn.execute(
            select(t.speakers.c.speaker_id, t.speakers.c.label)
            .where(t.speakers.c.transcript_id == transcript_id)
            .order_by(t.speakers.c.position)
        )
    ).all()
    segments = (
        await conn.execute(
            select(t.segments.c.speaker_id, t.segments.c.start_ms, t.segments.c.text)
            .where(t.segments.c.transcript_id == transcript_id)
            .order_by(t.segments.c.position)
        )
    ).all()
    return render_transcript(
        title=head["title"],
        recorded_at=head["recorded_at"].strftime("%d/%m/%Y"),
        speakers={row.speaker_id: row.label for row in speakers},
        segments=[(speaker_id, start_ms, text_) for speaker_id, start_ms, text_ in segments],
    )


async def _update_open(engine: AsyncEngine, summary_id: UUID, **values: Any) -> None:  # noqa: ANN401
    """Atualiza o resumo se ele ainda existe e está em aberto (o dono pode tê-lo apagado)."""
    async with system_tx(engine) as conn:
        await conn.execute(
            update(t.summaries)
            .where(t.summaries.c.id == summary_id, t.summaries.c.status.in_(["queued", "running"]))
            .values(**values)
        )


async def _fail(engine: AsyncEngine, summary_id: UUID, code: str, message: str, attempts: int) -> str:
    await _update_open(
        engine,
        summary_id,
        status="failed",
        error_code=code,
        error_message=message,
        attempts=attempts,
        completed_at=func.now(),
    )
    log.warning("resumo %s falhou: %s — %s", summary_id, code, message)
    return f"falhou: {code}"


def _default_factory(ctx: dict[str, Any]) -> Callable[[ProviderConfig], Provider]:
    async def gpu_idle() -> bool:
        return await ctx["redis"].zcard(GPU_QUEUE) == 0

    settings: Settings = ctx["settings"]
    return lambda config: build_provider(config, claude_bin=settings.claude_bin, gpu_idle=gpu_idle)


async def run_summary(ctx: dict[str, Any], summary_id: UUID) -> str:  # noqa: PLR0911 — um desfecho por caminho do job
    """O job `summarize`: gera o resumo e grava `done` ou `failed`; falha passageira volta à fila.

    `ctx` é o do worker arq: `engine`, `settings` e `redis`, e — nos testes — `provider_factory`,
    `retry_delays` e `gpu_retry_s`.
    """
    engine: AsyncEngine = ctx["engine"]
    async with system_tx(engine) as conn:
        summary = (
            (await conn.execute(select(t.summaries).where(t.summaries.c.id == summary_id).with_for_update()))
            .mappings()
            .first()
        )
        if summary is None:
            return "resumo apagado"
        if summary["status"] not in {"queued", "running"}:
            return f"resumo já {summary['status']}"
        provider_row = (
            (await conn.execute(select(t.agent_providers).where(t.agent_providers.c.id == summary["provider_id"])))
            .mappings()
            .first()
        )
        # O provider `anthropic` sem chave própria usa o segredo `anthropic_api_key` da plataforma.
        platform_key = None
        if provider_row is not None and provider_row["kind"] == "anthropic" and not provider_row["api_key_encrypted"]:
            platform_key = await secret_encrypted(conn, ANTHROPIC_API_KEY)
        transcript = await _transcript_text(conn, summary["transcript_id"])
        await conn.execute(
            update(t.summaries)
            .where(t.summaries.c.id == summary_id)
            .values(status="running", started_at=func.coalesce(t.summaries.c.started_at, func.now()))
        )
    attempts = summary["attempts"] + 1
    if provider_row is None or not provider_row["enabled"]:
        return await _fail(
            engine, summary_id, PROVIDER_NOT_CONFIGURED, "O provider foi removido ou desabilitado.", attempts
        )
    try:
        config = provider_config(ctx["settings"], provider_row, platform_key)
    except SecretDecryptError:
        message = "A chave de API do provider não abre com a chave de cifra atual; cadastre-a de novo."
        return await _fail(engine, summary_id, PROVIDER_NOT_CONFIGURED, message, attempts)
    factory = ctx.get("provider_factory") or _default_factory(ctx)
    try:
        async with asyncio.timeout(JOB_TIMEOUT_S):
            completion = await summarize(factory(config), transcript, summary["instructions"])
    except TimeoutError:
        message = f"O resumo passou de {JOB_TIMEOUT_S // 60} min."
        return await _fail(engine, summary_id, PROVIDER_TIMEOUT, message, attempts)
    except ProviderError as exc:
        return await _on_error(ctx, summary, config, exc, attempts)
    except Exception:
        log.exception("resumo %s: falha inesperada", summary_id)
        return await _fail(engine, summary_id, INTERNAL_ERROR, "Falha inesperada ao gerar o resumo.", attempts)
    await _update_open(
        engine,
        summary_id,
        status="done",
        content_md=completion.text,
        model=completion.model,
        attempts=attempts,
        error_code=None,
        error_message=None,
        completed_at=func.now(),
    )
    return "done"


async def _on_error(
    ctx: dict[str, Any], summary: Row, config: ProviderConfig, exc: ProviderError, attempts: int
) -> str:
    """Adia (fila da GPU), retenta (falha passageira) ou falha de vez."""
    engine: AsyncEngine = ctx["engine"]
    summary_id = summary["id"]
    if exc.code == GPU_BUSY:
        wait = config.options.get("ollama_wait_s", OLLAMA_WAIT_S)
        waited = (datetime.now(UTC) - summary["created_at"]).total_seconds()
        if isinstance(wait, int | float) and waited < wait:
            # Esperar a GPU não é uma tentativa: o provider nem foi chamado.
            await _update_open(engine, summary_id, status="queued")
            raise Retry(defer=ctx.get("gpu_retry_s", GPU_RETRY_S))
        return await _fail(engine, summary_id, GPU_BUSY, "A fila da GPU não esvaziou a tempo para o Ollama.", attempts)
    if exc.retryable and attempts < MAX_ATTEMPTS:
        delays = ctx.get("retry_delays", RETRY_DELAYS_S)
        await _update_open(engine, summary_id, status="queued", attempts=attempts)
        log.info("resumo %s: tentativa %d falhou (%s), nova tentativa", summary_id, attempts, exc.code)
        raise Retry(defer=delays[min(attempts, len(delays)) - 1])
    return await _fail(engine, summary_id, exc.code, exc.message, attempts)
