"""Worker CPU do server (`arq eclume_server.worker.WorkerSettings`), fila `eclume:default`.

Consome o que o worker GPU enfileira ao fim de um `transcribe` — `ingest_transcript` e
`transcription_failed` —, gera os resumos (`summarize`), descarta uploads vencidos e marca como
falha recuperável o job de transcrição que o worker GPU abandonou (`reap_stalled_jobs`). Contrato em
docs/standards/api/jobs-transcricao.md.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from arq import cron
from arq.connections import RedisSettings
from arq.worker import func
from sqlalchemy import select, update

from eclume_server.config import Settings, get_settings
from eclume_server.db import tables as t
from eclume_server.db.session import make_engine, system_tx
from eclume_server.queue import DEFAULT_QUEUE, progress_key, summarize_job_id
from eclume_server.stalled import reap
from eclume_server.storage import Storage
from eclume_server.summaries import auto_summarize, run_summary
from eclume_server.transcripts import fail, ingest

log = logging.getLogger("eclume_server.worker")
SUMMARIZE_TIMEOUT_S = 30 * 60
SUMMARIZE_MAX_TRIES = 500


async def startup(ctx: dict[str, Any]) -> None:
    """Engine e storage do processo; `ctx["settings"]` substitui o ambiente (testes)."""
    settings: Settings = ctx.get("settings") or get_settings()
    ctx["settings"] = settings
    ctx["engine"] = make_engine(settings.database_url)
    ctx["storage"] = Storage(settings)


async def shutdown(ctx: dict[str, Any]) -> None:
    """Fecha o pool do banco."""
    await ctx["engine"].dispose()


async def ingest_transcript(
    ctx: dict[str, Any],
    recording_id: str,
    transcript_key: str,
    embeddings_key: str | None,
    engine_info: dict[str, Any] | None,
) -> str:
    """Persiste a transcrição produzida pelo worker GPU e marca a gravação como `transcribed`."""
    async with system_tx(ctx["engine"]) as conn:
        result = await ingest(
            conn,
            ctx["storage"],
            UUID(recording_id),
            transcript_key=transcript_key,
            embeddings_key=embeddings_key,
            engine_info=engine_info,
        )
        # Na mesma transação: a transcrição e o seu resumo automático nascem juntos ou não nascem.
        summary_id = await auto_summarize(conn, UUID(recording_id))
    await ctx["redis"].delete(progress_key(recording_id))
    if summary_id is not None:
        await ctx["redis"].enqueue_job(
            "summarize", str(summary_id), _job_id=summarize_job_id(summary_id), _queue_name=DEFAULT_QUEUE
        )
        result += f"; resumo automático {summary_id} na fila"
    log.info("ingest_transcript %s: %s", recording_id, result)
    return result


async def transcription_failed(ctx: dict[str, Any], recording_id: str, error_code: str, message: str) -> str:
    """Marca o job e a gravação como falhos."""
    async with system_tx(ctx["engine"]) as conn:
        result = await fail(conn, UUID(recording_id), error_code, message)
    await ctx["redis"].delete(progress_key(recording_id))
    log.info("transcription_failed %s: %s", recording_id, result)
    return result


async def summarize(ctx: dict[str, Any], summary_id: str) -> str:
    """Gera um resumo (docs/standards/code/server-agentes.md)."""
    result = await run_summary(ctx, UUID(summary_id))
    log.info("summarize %s: %s", summary_id, result)
    return result


async def expire_uploads(ctx: dict[str, Any]) -> int:
    """Aborta os uploads em andamento que passaram do prazo."""
    now = datetime.now(UTC)
    async with system_tx(ctx["engine"]) as conn:
        rows = (
            (
                await conn.execute(
                    select(t.uploads)
                    .where(t.uploads.c.status == "in_progress", t.uploads.c.expires_at <= now)
                    .with_for_update(skip_locked=True)
                )
            )
            .mappings()
            .all()
        )
        for row in rows:
            await ctx["storage"].abort_multipart(row["audio_key"], row["s3_upload_id"])
            await conn.execute(update(t.uploads).where(t.uploads.c.id == row["id"]).values(status="expired"))
    return len(rows)


async def reap_stalled_jobs(ctx: dict[str, Any]) -> int:
    """Marca como falha recuperável os jobs de transcrição que ninguém mais vai terminar."""
    reaped = await reap(ctx["engine"], ctx["redis"], ctx["settings"])
    return len(reaped)


def worker_settings(settings: Settings) -> dict[str, Any]:
    """Parâmetros do `arq.Worker` para esta configuração."""
    return {
        "functions": [
            ingest_transcript,
            transcription_failed,
            # As tentativas são contadas no banco (`summaries.attempts`); o arq só precisa não
            # desistir antes, e esperar a GPU (Ollama) re-enfileira sem gastar tentativa.
            func(summarize, timeout=SUMMARIZE_TIMEOUT_S, max_tries=SUMMARIZE_MAX_TRIES),
        ],
        "cron_jobs": [
            cron(expire_uploads, minute={0, 30}, run_at_startup=False),
            # A cada minuto; `unique` evita duas varreduras sobrepostas com dois workers CPU.
            cron(reap_stalled_jobs, second=0, run_at_startup=False, unique=True),
        ],
        "queue_name": DEFAULT_QUEUE,
        "redis_settings": RedisSettings.from_dsn(settings.redis_url),
        "on_startup": startup,
        "on_shutdown": shutdown,
        "ctx": {"settings": settings},
    }


_FROM_ENV = worker_settings(get_settings())


class WorkerSettings:
    """Entrada do CLI do arq; lê `ECLUME_*` do ambiente na importação."""

    functions = _FROM_ENV["functions"]
    cron_jobs = _FROM_ENV["cron_jobs"]
    queue_name = _FROM_ENV["queue_name"]
    redis_settings = _FROM_ENV["redis_settings"]
    on_startup = _FROM_ENV["on_startup"]
    on_shutdown = _FROM_ENV["on_shutdown"]
    ctx = _FROM_ENV["ctx"]
