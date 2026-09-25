"""Worker CPU do server (`arq eclume_server.worker.WorkerSettings`), fila `eclume:default`.

Consome o que o worker GPU enfileira ao fim de um `transcribe` — `ingest_transcript` e
`transcription_failed` — e descarta uploads vencidos. Contrato em
docs/standards/api/jobs-transcricao.md.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from arq import cron
from arq.connections import RedisSettings
from sqlalchemy import select, update

from eclume_server.config import Settings, get_settings
from eclume_server.db import tables as t
from eclume_server.db.session import make_engine, system_tx
from eclume_server.queue import DEFAULT_QUEUE, progress_key
from eclume_server.storage import Storage
from eclume_server.transcripts import fail, ingest

log = logging.getLogger("eclume_server.worker")


async def startup(ctx: dict[str, Any]) -> None:
    """Engine e storage do processo; `ctx["settings"]` substitui o ambiente (testes)."""
    settings: Settings = ctx.get("settings") or get_settings()
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
    await ctx["redis"].delete(progress_key(recording_id))
    log.info("ingest_transcript %s: %s", recording_id, result)
    return result


async def transcription_failed(ctx: dict[str, Any], recording_id: str, error_code: str, message: str) -> str:
    """Marca o job e a gravação como falhos."""
    async with system_tx(ctx["engine"]) as conn:
        result = await fail(conn, UUID(recording_id), error_code, message)
    await ctx["redis"].delete(progress_key(recording_id))
    log.info("transcription_failed %s: %s", recording_id, result)
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


def worker_settings(settings: Settings) -> dict[str, Any]:
    """Parâmetros do `arq.Worker` para esta configuração."""
    return {
        "functions": [ingest_transcript, transcription_failed],
        "cron_jobs": [cron(expire_uploads, minute={0, 30}, run_at_startup=False)],
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
