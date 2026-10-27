"""The server's CPU workers: `eclume:default` (`WorkerSettings`) and `eclume:agents` (`AgentWorkerSettings`).

In production both run in the same process and the same event loop (`eclume-server worker`,
`run_combined`): two `arq.Worker`s, each with its own queue, slots, functions and crons, but with
a single database engine and a single storage client. `WorkerSettings` and `AgentWorkerSettings`
still hold for a standalone `arq` (staging, e2e, tests).

The `eclume:default` one consumes what the GPU worker enqueues at the end of a `transcribe` —
`ingest_transcript` and `transcription_failed` —, purges the embeddings and runs the crons: it
discards expired uploads, marks as a recoverable failure the transcription job the GPU worker
abandoned and the chat reply no job will finish (`reap_stalled_jobs`), and relaunches the agent
step or the summary that never reached the queue (`resume_pipelines`). The `eclume:agents` one
(`ECLUME_AGENT_MAX_JOBS` slots) runs the pipeline's agent steps (`detect_agenda_type`,
`fill_fields` and the automatic summary), generates the summaries (`summarize`), and answers the
chats and the previews: ingestion never waits behind an agent call. Contract in
docs/standards/api/jobs-transcricao.md and docs/standards/code/processamento-automatico.md.
"""

from __future__ import annotations

import asyncio
import logging
import signal
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import UUID

from arq import Retry, cron
from arq.connections import RedisSettings
from arq.worker import Worker, func
from sqlalchemy import delete, select, update

from eclume_engines.fila import desserializar
from eclume_engines.registro import configurar_logs, contexto_do_job
from eclume_server.agenda_types import ensure_type, run_detect
from eclume_server.agent_actions import run_agent_action_job
from eclume_server.agent_sessions import run_agent_turn_job
from eclume_server.audio_retention import purge_due_audio
from eclume_server.base_chat import run_base_chat_job
from eclume_server.config import Settings, get_settings
from eclume_server.db import tables as t
from eclume_server.db.session import make_runtime_engine, system_tx
from eclume_server.dispatch import dispatch_waiting, next_for_recording
from eclume_server.fields import run_fill_fields
from eclume_server.pipeline import GONE, STALE, current_revision, set_step
from eclume_server.previews import run_preview
from eclume_server.queue import (
    AGENT_QUEUE,
    DEFAULT_QUEUE,
    enqueue_summary,
    progress_key,
    return_revision,
    step_job_id,
)
from eclume_server.resume import resume
from eclume_server.stalled import INGEST_FAILED, INGEST_FAILED_MESSAGE, reap
from eclume_server.storage import Storage
from eclume_server.storage_deletions import drain, reconcile
from eclume_server.summaries import INTERNAL_ERROR, run_summary, start_auto_summary
from eclume_server.summary_chat import CHAT_TIMEOUT_S, reap_stalled_chats, run_summary_chat
from eclume_server.transcripts import fail, ingest
from eclume_server.transient import is_transient
from eclume_server.voice import keeps_samples, platform_voice

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from sqlalchemy.ext.asyncio import AsyncConnection

log = logging.getLogger("eclume_server.worker")
AGENT_ACTION_TIMEOUT_S = 600
SUMMARIZE_TIMEOUT_S = 30 * 60
SUMMARIZE_MAX_TRIES = 500
# Slots of the `eclume:default` worker (arq's default, made explicit): only ingestion, failures and sweeps.
DEFAULT_MAX_JOBS = 10
DEFAULT_POLL_DELAY_S = 2.0
AGENT_POLL_DELAY_S = 1.0
# Transient Postgres or S3 failure in the GPU worker's return jobs: 3 retries with a growing
# delay (315 s in total, below `job_stall_seconds`, so the reaper does not decide first).
INGEST_RETRY_DELAYS_S = (15, 60, 240)
RETURN_MAX_TRIES = len(INGEST_RETRY_DELAYS_S) + 1
# Expired, unused pairing codes are removed after this (cron `expire_pairing_codes`).
PAIRING_RETENTION = timedelta(days=1)
# Sessions (user and admin) expired for longer than this are removed (cron `purge_expired`).
SESSION_RETENTION = timedelta(days=1)
# Terminal uploads older than this are removed: an app that resumes later gets a 404 and opens
# another one, which falls into the recording's hash dedup.
UPLOAD_RETENTION = timedelta(days=30)
TERMINAL_UPLOADS = ("completed", "deduplicated", "aborted", "expired")


async def startup(ctx: dict[str, Any]) -> None:
    """The process's logging, engine and storage; `ctx["settings"]` overrides the environment (tests).

    An `engine` and a `storage` already in `ctx` (the single worker shares them between the
    queues) are left as they are, and whoever created them closes them.
    """
    configurar_logs()
    settings: Settings = ctx.get("settings") or get_settings()
    ctx["settings"] = settings
    if "engine" not in ctx:
        ctx["engine"] = make_runtime_engine(settings, worker=True)
        ctx["engine_owned"] = True
    ctx.setdefault("storage", Storage(settings))


async def shutdown(ctx: dict[str, Any]) -> None:
    """Close the database pool, if this worker opened it."""
    if ctx.get("engine_owned"):
        await ctx["engine"].dispose()


async def job_start(ctx: dict[str, Any]) -> None:
    """Put `job_id`, `recording_id` and `revision` in the log context of the job about to run.

    arq calls this in the job's task, before the function; the context holds for that job only.
    """
    contexto_do_job(ctx.get("job_id"))


async def ingest_transcript(
    ctx: dict[str, Any],
    recording_id: str,
    transcript_key: str,
    embeddings_key: str | None,
    engine_info: dict[str, Any] | None,
) -> str:
    """Persist the transcript produced by the GPU worker and mark the recording as `transcribed`.

    The revision comes from the `_job_id` (`ingest_transcript:{recording_id}:{revision}`); without
    it (an old worker), the most recent job holds. The message of a revision that is no longer open
    is ignored. A failing ingestion rolls back the whole transaction; in a new transaction, the job
    and the recording become the recoverable failure `ingest_failed`, so the recording does not stay
    stuck in the queue. Only whoever closes the job deletes the progress hash. A transient Postgres
    or S3 failure goes back to the queue before that (`INGEST_RETRY_DELAYS_S`); a permanent one, or
    a transient one that outlasts every attempt, becomes `ingest_failed`.
    """
    job_revision = return_revision("ingest_transcript", recording_id, ctx.get("job_id"))
    try:
        async with system_tx(ctx["engine"]) as conn:
            outcome = await ingest(
                conn,
                ctx["storage"],
                UUID(recording_id),
                transcript_key=transcript_key,
                embeddings_key=embeddings_key,
                engine_info=engine_info,
                revision=job_revision,
            )
            revision = await current_revision(conn, UUID(recording_id))
    except Exception as exc:
        _retry_if_transient(ctx, "ingest_transcript", recording_id, exc)
        log.exception("ingest_transcript %s (revision %s): ingestion failed", recording_id, job_revision)
        async with system_tx(ctx["engine"]) as conn:
            result = await fail(conn, UUID(recording_id), INGEST_FAILED, INGEST_FAILED_MESSAGE, revision=job_revision)
        if result.closed:
            await ctx["redis"].delete(progress_key(recording_id))
        log.info("ingest_transcript %s: %s", recording_id, result.message)
        await next_for_recording(ctx["engine"], ctx["redis"], recording_id)
        return f"falhou: {INGEST_FAILED}"
    if outcome.persisted or outcome.gone:
        await ctx["redis"].delete(progress_key(recording_id))
    if outcome.gone:
        # Deleted during transcription: the artifacts the GPU worker just wrote do not stay.
        await ctx["storage"].delete_artifacts(recording_id)
    elif outcome.persisted:
        await _keep_only_revision(ctx["storage"], recording_id, outcome.revision)
        # The agent chain starts with the type, only when this ingestion wrote the transcript and no
        # speaker is waiting to be named (the route that names it enqueues the type).
        if not outcome.waiting:
            await _enqueue_step(ctx, "detect_agenda_type", recording_id, revision)
    log.info("ingest_transcript %s: %s", recording_id, outcome.message)
    # The GPU is free for this account: its next held job enters the queue.
    await next_for_recording(ctx["engine"], ctx["redis"], recording_id)
    return outcome.message


def _retry_if_transient(ctx: dict[str, Any], job: str, recording_id: str, exc: Exception) -> None:
    """Raise `Retry` (outside the transaction) if the failure is transient and an attempt is left."""
    delays = ctx.get("ingest_retry_delays", INGEST_RETRY_DELAYS_S)
    attempt = ctx.get("job_try", 1)
    if attempt <= len(delays) and is_transient(exc):
        log.warning(
            "%s %s: transient failure on attempt %d (%s: %s); retrying",
            job,
            recording_id,
            attempt,
            type(exc).__name__,
            exc,
        )
        raise Retry(defer=delays[attempt - 1]) from exc


async def _keep_only_revision(storage: Storage, recording_id: str, revision: int | None) -> None:
    """After the commit, the bucket keeps only the stored revision's artifacts; a failure here only goes to the log.

    Whatever is left is removed on the next ingestion or when the recording is deleted.
    """
    if revision is None:
        return
    try:
        await storage.delete_other_revisions(recording_id, revision)
    except Exception:
        log.exception("ingest_transcript %s: cleaning up the other revisions failed", recording_id)


async def _enqueue_step(ctx: dict[str, Any], job: str, recording_id: str, revision: int) -> None:
    await ctx["redis"].enqueue_job(
        job, recording_id, revision, _job_id=step_job_id(job, recording_id, revision), _queue_name=AGENT_QUEUE
    )


async def _run_step(
    ctx: dict[str, Any],
    step: str,
    recording_id: str,
    revision: int,
    run: Callable[[dict[str, Any], UUID, int], Awaitable[str]],
) -> str:
    """Run the agent step; an unexpected failure outside the agent call leaves the step `failed`.

    A `Retry` (a transient agent failure) goes back to the queue as always; anything else becomes
    `internal_error`, and the caller continues the chain.
    """
    try:
        return await run(ctx, UUID(recording_id), revision)
    except Retry:
        raise
    except Exception as exc:
        log.exception("step %s of %s (revision %d): unexpected failure", step, recording_id, revision)
        async with system_tx(ctx["engine"]) as conn:
            recording = (
                (
                    await conn.execute(
                        select(t.recordings.c.id, t.recordings.c.owner_id).where(
                            t.recordings.c.id == UUID(recording_id)
                        )
                    )
                )
                .mappings()
                .first()
            )
            if recording is None:
                return GONE
            if await current_revision(conn, recording["id"]) != revision:
                return STALE
            await set_step(conn, recording, revision, step, "failed", error=(INTERNAL_ERROR, type(exc).__name__))
        return f"falhou: {INTERNAL_ERROR}"


async def detect_agenda_type(ctx: dict[str, Any], recording_id: str, revision: int) -> str:
    """Choose and apply the revision's agenda type (or the fallback one) and move on to the fields."""
    result = await _run_step(ctx, "agenda_type", recording_id, revision, run_detect)
    if result not in {GONE, STALE}:
        # Skipped or failed, the recording gets the fallback type: the summary always has a type. Not
        # even a failure here stops the chain.
        try:
            async with system_tx(ctx["engine"]) as conn:
                await ensure_type(conn, UUID(recording_id))
        except Exception:
            log.exception("detect_agenda_type %s: the fallback type was not applied", recording_id)
        await _enqueue_step(ctx, "fill_fields", recording_id, revision)
    log.info("detect_agenda_type %s (revision %d): %s", recording_id, revision, result)
    return result


async def fill_fields(ctx: dict[str, Any], recording_id: str, revision: int) -> str:
    """Fill the revision's automatic fields and open the automatic summary for the type."""
    result = await _run_step(ctx, "fields", recording_id, revision, run_fill_fields)
    if result not in {GONE, STALE}:
        async with system_tx(ctx["engine"]) as conn:
            summary_id = await start_auto_summary(conn, UUID(recording_id), revision)
        if summary_id is not None:
            await enqueue_summary(ctx["redis"], summary_id)
            result += f"; resumo automático {summary_id} na fila"
    log.info("fill_fields %s (revision %d): %s", recording_id, revision, result)
    return result


async def transcription_failed(
    ctx: dict[str, Any], recording_id: str, error_code: str, message: str, stage: str | None = None
) -> str:
    """Mark the revision's job and the recording as failed; `stage` (a new worker) names the failed stage.

    The revision comes from the `_job_id` (`transcription_failed:{recording_id}:{revision}`), as in
    ingestion. A transient Postgres failure goes back to the queue as in ingestion; once the attempts
    run out, it re-raises, and the reaper covers the job.
    """
    revision = return_revision("transcription_failed", recording_id, ctx.get("job_id"))
    started_at = await ctx["redis"].hget(progress_key(recording_id), "started_at")
    if isinstance(started_at, bytes):
        started_at = started_at.decode()
    try:
        async with system_tx(ctx["engine"]) as conn:
            result = await fail(
                conn, UUID(recording_id), error_code, message, stage, revision=revision, started_at=started_at
            )
    except Exception as exc:
        _retry_if_transient(ctx, "transcription_failed", recording_id, exc)
        raise
    if result.closed:
        await ctx["redis"].delete(progress_key(recording_id))
    log.info("transcription_failed %s (revision %s): %s", recording_id, revision, result.message)
    await next_for_recording(ctx["engine"], ctx["redis"], recording_id)
    return result.message


async def purge_embedding_objects(ctx: dict[str, Any], owner_id: str | None = None) -> int:
    """Delete the `speaker_embeddings.json` files from the bucket: for the whole platform or one account only.

    Without an owner (voice turned off on the platform), it lists `recordings/`: it reaches every
    revision and the old keys without a revision; nothing is deleted if voice identification was
    turned back on in the meantime. With an owner (the account stopped keeping samples), only the
    account's recordings, and nothing if it keeps them again. An old job, with no argument, still
    applies to the platform.
    """
    async with system_tx(ctx["engine"]) as conn:
        if owner_id is None:
            if (await platform_voice(conn))["enabled"]:
                return 0
            recording_ids = None
        else:
            owner = UUID(owner_id)
            if await keeps_samples(conn, owner):
                return 0
            query = select(t.recordings.c.id).where(t.recordings.c.owner_id == owner)
            recording_ids = list((await conn.execute(query)).scalars())
    deleted = await ctx["storage"].delete_embedding_objects(recording_ids)
    log.info("purge_embedding_objects %s: %d arquivos", owner_id or "plataforma", deleted)
    return deleted


async def summarize(ctx: dict[str, Any], summary_id: str) -> str:
    """Generate a summary (docs/standards/code/server-agentes.md)."""
    result = await run_summary(ctx, UUID(summary_id))
    log.info("summarize %s: %s", summary_id, result)
    return result


async def summary_chat(ctx: dict[str, Any], message_id: str) -> str:
    """Answer a request of the summary's adjustment chat (docs/standards/code/server-agentes.md)."""
    result = await run_summary_chat(ctx, UUID(message_id))
    log.info("summary_chat %s: %s", message_id, result)
    return result


async def agent_turn(
    ctx: dict[str, Any],
    message_id: str,
    transcripts: bool = True,  # noqa: FBT001, FBT002
    scopes: list[str] | None = None,
) -> str:
    """Answer a question to the Agent (docs/standards/code/server-agentes.md `§Agente`)."""
    result = await run_agent_turn_job(ctx, message_id, transcripts, scopes)
    log.info("agent_turn %s: %s", message_id, result)
    return result


async def agent_action(ctx: dict[str, Any], action_id: str, attempt: int = 0) -> str:
    """Run a confirmed Agent action, target by target (docs/standards/code/server-agentes.md `§Agente`)."""
    result = await run_agent_action_job(ctx, action_id, attempt)
    log.info("agent_action %s: %s", action_id, result)
    return result


async def base_chat(ctx: dict[str, Any], chat_id: str) -> str:
    """Answer a question of the base chat (docs/standards/code/server-agentes.md)."""
    result = await run_base_chat_job(ctx, chat_id)
    log.info("base_chat %s: %s", chat_id, result)
    return result


async def expire_uploads(ctx: dict[str, Any]) -> int:
    """Abort the in-progress uploads that are past their deadline."""
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


async def purge_pairing_codes(conn: AsyncConnection, now: datetime | None = None) -> int:
    """Delete the pairing codes expired without use for longer than `PAIRING_RETENTION`.

    It lives here, not in `devices.py`, because that one imports `routes` and the worker does not load the API.
    """
    cutoff = (now or datetime.now(UTC)) - PAIRING_RETENTION
    codes = t.pairing_codes
    result = await conn.execute(delete(codes).where(codes.c.used_at.is_(None), codes.c.expires_at < cutoff))
    return result.rowcount


async def expire_pairing_codes(ctx: dict[str, Any]) -> int:
    """Cron: expired unused codes are removed; used ones stay with their `token_id`."""
    async with system_tx(ctx["engine"]) as conn:
        return await purge_pairing_codes(conn)


async def purge_stale_rows(conn: AsyncConnection, now: datetime | None = None) -> dict[str, int]:
    """Delete sessions expired for longer than `SESSION_RETENTION` and terminal uploads older than `UPLOAD_RETENTION`."""
    now = now or datetime.now(UTC)
    removed = {}
    for table in (t.sessions, t.admin_sessions):
        result = await conn.execute(delete(table).where(table.c.expires_at < now - SESSION_RETENTION))
        removed[table.name] = result.rowcount
    uploads = t.uploads.c
    result = await conn.execute(
        delete(t.uploads).where(uploads.status.in_(TERMINAL_UPLOADS), uploads.created_at < now - UPLOAD_RETENTION)
    )
    removed["uploads"] = result.rowcount
    return removed


async def purge_expired(ctx: dict[str, Any]) -> int:
    """Daily cron: minimum retention of sessions and uploads; `api_tokens` stay (the user sees the revoked ones)."""
    async with system_tx(ctx["engine"]) as conn:
        removed = await purge_stale_rows(conn)
    log.info("purge_expired: %s", removed)
    return sum(removed.values())


async def purge_audio(ctx: dict[str, Any]) -> int:
    """Daily cron: delete the audio of recordings past their account's retention, keeping transcript and summary."""
    return await purge_due_audio(ctx["engine"])


async def reap_stalled_jobs(ctx: dict[str, Any]) -> int:
    """Mark as failed the transcription jobs and chat replies that nobody will finish anymore."""
    reaped = await reap(ctx["engine"], ctx["redis"], ctx["settings"])
    return len(reaped) + await reap_stalled_chats(ctx["engine"])


async def dispatch_transcriptions(ctx: dict[str, Any]) -> int:
    """Safety net of the per-account turn dispatch: put on the GPU the held job of an account with none there."""
    return len(await dispatch_waiting(ctx["engine"], ctx["redis"]))


async def drain_storage_deletions(ctx: dict[str, Any]) -> int:
    """Remove from the bucket what the deletion queue holds (`storage_deletions.py`)."""
    return await drain(ctx["engine"], ctx["storage"])


async def reconcile_storage(ctx: dict[str, Any]) -> int:
    """Put in the deletion queue what has been in the bucket without a database row for more than 24 h."""
    return await reconcile(ctx["engine"], ctx["storage"])


async def resume_pipelines(ctx: dict[str, Any]) -> int:
    """Relaunch the agent steps and summaries that never reached the queue (`resume.py`)."""
    return len(await resume(ctx["engine"], ctx["redis"]))


def _agent_functions() -> list[Any]:
    return [
        # Attempts are counted in the database (`summaries.attempts`); arq only needs not to give
        # up first, and waiting for the GPU (Ollama) re-enqueues without spending an attempt.
        func(summarize, timeout=SUMMARIZE_TIMEOUT_S, max_tries=SUMMARIZE_MAX_TRIES),
        # The agent steps count their attempts in the step's `detail`, as the summary does in the database.
        func(fill_fields, timeout=SUMMARIZE_TIMEOUT_S, max_tries=SUMMARIZE_MAX_TRIES),
        func(detect_agenda_type, timeout=SUMMARIZE_TIMEOUT_S, max_tries=SUMMARIZE_MAX_TRIES),
        func(run_preview, timeout=SUMMARIZE_TIMEOUT_S),
        # Above the loop's ceiling, so the reply ends `failed` and not stuck in `running`; a single
        # retry (counted in `summary_chat_messages.attempts`).
        func(summary_chat, timeout=CHAT_TIMEOUT_S + 60, max_tries=3),
        # No retry: the state lives in Redis and the person asks again.
        func(base_chat, timeout=CHAT_TIMEOUT_S + 60, max_tries=1),
        # No retry: the reply ends `failed` and the person asks again.
        func(agent_turn, timeout=CHAT_TIMEOUT_S + 60, max_tries=1),
        # Up to 50 targets, each in a short transaction; the per-target result makes a retry safe.
        func(agent_action, timeout=AGENT_ACTION_TIMEOUT_S, max_tries=3),
    ]


def worker_settings(settings: Settings) -> dict[str, Any]:
    """Parameters of the `eclume:default` `arq.Worker` for this configuration."""
    return {
        "functions": [
            # Only a transient failure goes back to the queue (`Retry`); the rest ends on the first attempt.
            func(ingest_transcript, max_tries=RETURN_MAX_TRIES),
            func(transcription_failed, max_tries=RETURN_MAX_TRIES),
            purge_embedding_objects,
        ],
        "cron_jobs": [
            cron(expire_uploads, minute={0, 30}, run_at_startup=False),
            cron(expire_pairing_codes, minute=15, run_at_startup=False, unique=True),
            cron(purge_expired, hour=3, minute=40, run_at_startup=False, unique=True),
            cron(purge_audio, hour=3, minute=50, run_at_startup=False, unique=True),
            # Every minute; `unique` prevents two overlapping sweeps with two CPU workers.
            cron(reap_stalled_jobs, second=0, run_at_startup=False, unique=True),
            # The held job whose dispatch never came (reaper, cancellation, deletion, minutes window).
            cron(dispatch_transcriptions, second=15, run_at_startup=False, unique=True),
            cron(resume_pipelines, minute=set(range(2, 60, 5)), run_at_startup=False, unique=True),
            cron(drain_storage_deletions, second=30, run_at_startup=False, unique=True),
            cron(reconcile_storage, weekday="sun", hour=4, minute=0, run_at_startup=False, unique=True),
        ],
        "queue_name": DEFAULT_QUEUE,
        "max_jobs": DEFAULT_MAX_JOBS,
        # The default queue has little traffic and the finest sweeps are 15 s: polling every 2 s is enough.
        "poll_delay": DEFAULT_POLL_DELAY_S,
        # arq's health-check key (`eclume:default:health-check`) is the Health probe.
        "health_check_interval": 15,
        "redis_settings": RedisSettings.from_dsn(settings.redis_url),
        "on_startup": startup,
        "on_shutdown": shutdown,
        "on_job_start": job_start,
        "ctx": {"settings": settings},
        # Phase A of the pickle-free queue: reads JSON and the old pickle without globals.
        "job_deserializer": desserializar,
    }


def agent_worker_settings(settings: Settings) -> dict[str, Any]:
    """Parameters of the `eclume:agents` `arq.Worker`: the agent jobs, without crons."""
    return {
        "functions": _agent_functions(),
        "cron_jobs": None,
        "queue_name": AGENT_QUEUE,
        "max_jobs": settings.agent_max_jobs,
        # The Agent is interactive (chat, actions): 1 s of wait for the first job is the accepted ceiling.
        "poll_delay": AGENT_POLL_DELAY_S,
        # `eclume:agents:health-check`, the second key of the Health `cpu_worker` probe.
        "health_check_interval": 15,
        "redis_settings": RedisSettings.from_dsn(settings.redis_url),
        "on_startup": startup,
        "on_shutdown": shutdown,
        "on_job_start": job_start,
        "ctx": {"settings": settings},
        "job_deserializer": desserializar,
    }


_FROM_ENV = worker_settings(get_settings())
_AGENTS_FROM_ENV = agent_worker_settings(get_settings())


class WorkerSettings:
    """Entry point of the arq CLI; reads `ECLUME_*` from the environment on import."""

    functions = _FROM_ENV["functions"]
    cron_jobs = _FROM_ENV["cron_jobs"]
    queue_name = _FROM_ENV["queue_name"]
    health_check_interval = _FROM_ENV["health_check_interval"]
    redis_settings = _FROM_ENV["redis_settings"]
    on_startup = _FROM_ENV["on_startup"]
    on_shutdown = _FROM_ENV["on_shutdown"]
    on_job_start = _FROM_ENV["on_job_start"]
    ctx = _FROM_ENV["ctx"]
    max_jobs = _FROM_ENV["max_jobs"]
    poll_delay = _FROM_ENV["poll_delay"]
    job_deserializer = _FROM_ENV["job_deserializer"]


class AgentWorkerSettings:
    """Entry point of the arq CLI for the agent worker (`arq eclume_server.worker.AgentWorkerSettings`)."""

    functions = _AGENTS_FROM_ENV["functions"]
    cron_jobs = _AGENTS_FROM_ENV["cron_jobs"]
    queue_name = _AGENTS_FROM_ENV["queue_name"]
    max_jobs = _AGENTS_FROM_ENV["max_jobs"]
    poll_delay = _AGENTS_FROM_ENV["poll_delay"]
    health_check_interval = _AGENTS_FROM_ENV["health_check_interval"]
    redis_settings = _AGENTS_FROM_ENV["redis_settings"]
    on_startup = _AGENTS_FROM_ENV["on_startup"]
    on_shutdown = _AGENTS_FROM_ENV["on_shutdown"]
    on_job_start = _AGENTS_FROM_ENV["on_job_start"]
    ctx = _AGENTS_FROM_ENV["ctx"]
    job_deserializer = _AGENTS_FROM_ENV["job_deserializer"]


async def _run_worker(worker: Worker) -> None:
    """Run an `arq.Worker` until it ends or until the stop signal, and close it."""
    try:
        await worker.async_run()
    except asyncio.CancelledError:
        pass  # `handle_sig` cancelled the loop: a stop was requested
    finally:
        await worker.close()


async def run_combined(settings: Settings | None = None) -> None:
    """Run the `eclume:default` and `eclume:agents` workers in the same event loop.

    Each queue keeps its own slots (`max_jobs`), functions, crons and health-check key; the database
    engine and the storage are shared. SIGTERM and SIGINT go to both workers
    (`handle_signals=False`: arq registers no handler of its own, so that not only the last one's
    holds). It exits when both have finished; if one of them dies with an exception, the other is
    stopped and the exception propagates.
    """
    settings = settings or get_settings()
    engine = make_runtime_engine(settings, worker=True)
    shared = {"settings": settings, "engine": engine, "storage": Storage(settings)}
    workers = []
    for params in (worker_settings(settings), agent_worker_settings(settings)):
        params["ctx"] = params["ctx"] | shared
        workers.append(Worker(**params, handle_signals=False))

    def stop(signum: signal.Signals) -> None:
        for worker in workers:
            worker.handle_sig(signum)

    loop = asyncio.get_running_loop()
    signals = (signal.SIGINT, signal.SIGTERM)
    for signum in signals:
        loop.add_signal_handler(signum, stop, signum)
    tasks = [asyncio.create_task(_run_worker(worker)) for worker in workers]
    try:
        _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
        if pending:  # one of the workers died: the other does not stay alone
            stop(signal.SIGTERM)
        await asyncio.gather(*tasks)
    finally:
        for signum in signals:
            loop.remove_signal_handler(signum)
        await engine.dispose()


def main() -> None:
    """Entry point of `eclume-server worker`."""
    asyncio.run(run_combined())
