"""Summaries: platform configuration, versioned creation by agenda type, and the `summarize` job.

Contract and decisions in docs/standards/code/server-agentes.md.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from arq import Retry
from sqlalchemy import any_, delete, func, insert, literal, select, text, update

from eclume_server.agents import ProviderConfig, ProviderError, build_provider
from eclume_server.agents.base import GPU_BUSY, PROVIDER_NOT_CONFIGURED, PROVIDER_TIMEOUT
from eclume_server.agents.prompting import TranscriptText, render_transcript, summarize
from eclume_server.crypto import SecretDecryptError, decrypt
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.locale import job_locale
from eclume_server.pagination import iso
from eclume_server.pipeline import UNSUMMARIZED, mark_recording_changed, set_step
from eclume_server.problems import conflict, invalid_field, not_found
from eclume_server.queue import GPU_QUEUE
from eclume_server.settings_admin import ANTHROPIC_API_KEY, secret_encrypted

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

    from eclume_server.agents import Provider
    from eclume_server.config import Settings
    from eclume_server.serialize import Row


log = logging.getLogger(__name__)


# --- providers by purpose ------------------------------------------------------------------------

# Columns of `agent_providers` that `eclume_app` reads: the API key is for the connection role only.
PROVIDER_PUBLIC = [column for column in t.agent_providers.c if column.name != "api_key_encrypted"]
PURPOSES = ("summaries", "fields", "chat", "agenda_detection")


async def provider_for(conn: AsyncConnection, purpose: str) -> Row | None:
    """The enabled provider that declares the purpose (there is at most one), without the API key.

    The database guarantees one per purpose (migration 013); the order is registration order anyway.
    """
    c = t.agent_providers.c
    query = (
        select(*PROVIDER_PUBLIC)
        .where(c.enabled, literal(purpose) == any_(c.used_for))
        .order_by(c.created_at, c.id)
        .limit(1)
    )
    return (await conn.execute(query)).mappings().first()


# --- JSON shapes ------------------------------------------------------------------------------------


def _id(value: UUID | None) -> str | None:
    return str(value) if value is not None else None


def provider_ref(row: Row) -> dict[str, Any] | None:
    """Schema `AgentProviderRef` of the row's `provider_*` snapshot; `None` without a provider."""
    if row["provider_id"] is None:
        return None
    return {"id": str(row["provider_id"]), "name": row["provider_name"], "kind": row["provider_kind"]}


def summary_json(row: Row) -> dict[str, Any]:
    """Schema `Summary`, with agenda type and provider as a snapshot."""
    error = None
    if row["error_code"]:
        error = {"code": row["error_code"], "message": row["error_message"] or ""}
    agenda_type = None
    if row["agenda_type_id"] is not None:
        agenda_type = {"id": str(row["agenda_type_id"]), "name": row["agenda_type_name"]}
    return {
        "id": str(row["id"]),
        "transcript_id": str(row["transcript_id"]),
        "transcript_revision": row["transcript_revision"],
        "agenda_type": agenda_type,
        "version": row["version"],
        "origin": row["origin"],
        "status": row["status"],
        "trigger": row["trigger"],
        "provider": provider_ref(row),
        "model": row["model"],
        "content_md": row["content_md"] if row["status"] == "done" else None,
        "error": error,
        "restored_from_id": _id(row["restored_from_id"]),
        "chat_message_id": _id(row["chat_message_id"]),
        "created_by": _id(row["created_by"]),
        "created_at": iso(row["created_at"]),
        "completed_at": iso(row["completed_at"]),
    }


# --- creation ----------------------------------------------------------------------------------------


async def lock_versions(conn: AsyncConnection, transcript_id: UUID) -> None:
    """Serializes, until the end of the transaction, the new versions of the transcript's summary."""
    await conn.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"summary:{transcript_id}"},
    )


async def next_version(conn: AsyncConnection, transcript_id: UUID) -> int:
    """The next `version` of the transcript's summary (under `lock_versions`)."""
    s = t.summaries.c
    query = select(func.coalesce(func.max(s.version), 0) + 1).where(s.transcript_id == transcript_id)
    return (await conn.execute(query)).scalar_one()


async def create_summary(  # noqa: PLR0913 — the summary is born from transcript, type, provider and trigger
    conn: AsyncConnection,
    *,
    transcript: Row,
    agenda_type: Row,
    provider: Row,
    trigger: str,
    created_by: UUID,
) -> Row:
    """Inserts a `queued` summary with the transcript's next `version`.

    Serves the API (under the owner's RLS) and the automatic summary (connection role). The type's
    instructions go in as a snapshot. The transcript lock serializes the new versions.
    """
    await lock_versions(conn, transcript["id"])
    version = await next_version(conn, transcript["id"])
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


# --- recording versions (edit, revert to generated, state) -----------------------------------------

SUMMARY_CHANGED = "summary_changed"
SUMMARY_MISSING = "summary_missing"
TRANSCRIPT_MISSING = "transcript_missing"


async def recording_transcript(conn: AsyncConnection, recording_id: UUID) -> Row:
    """The user's recording transcript: 404 without the recording, 409 `transcript_missing` without a transcript."""
    visible = (await conn.execute(select(t.recordings.c.id).where(t.recordings.c.id == recording_id))).first()
    if visible is None:
        raise not_found("Recording does not exist or is not accessible.")
    transcript = (
        (await conn.execute(select(t.transcripts).where(t.transcripts.c.recording_id == recording_id)))
        .mappings()
        .first()
    )
    if transcript is None:
        raise conflict("The recording has no transcript yet.", code=TRANSCRIPT_MISSING)
    return transcript


async def summary_provider(conn: AsyncConnection, provider_id: UUID | None) -> Row:
    """The requested provider, or the platform's summaries provider; missing or disabled → 422."""
    field = "provider_id"
    if provider_id is None:
        provider = await provider_for(conn, "summaries")
        if provider is None:
            raise invalid_field(field, "the platform has no summary provider; send provider_id")
        return provider
    row = (await conn.execute(select(*PROVIDER_PUBLIC).where(t.agent_providers.c.id == provider_id))).mappings().first()
    if row is None:
        raise invalid_field(field, "provider does not exist")
    if not row["enabled"]:
        raise invalid_field(field, "provider disabled")
    return row


async def summary_agenda_type(conn: AsyncConnection, transcript: Row, agenda_type_id: UUID | None) -> Row:
    """The requested type, or the recording's; none → 422."""
    field = "agenda_type_id"
    if agenda_type_id is None:
        agenda_type_id = (
            await conn.execute(
                select(t.recordings.c.agenda_type_id).where(t.recordings.c.id == transcript["recording_id"])
            )
        ).scalar()
        if agenda_type_id is None:
            raise invalid_field(field, "the recording has no agenda type; send agenda_type_id")
    row = (await conn.execute(select(t.agenda_types).where(t.agenda_types.c.id == agenda_type_id))).mappings().first()
    if row is None:
        raise invalid_field(field, "agenda type does not exist or is not accessible")
    return row


def _latest(transcript_id: UUID, *conditions: Any) -> Any:  # noqa: ANN401 — SQLAlchemy Select
    s = t.summaries.c
    return select(t.summaries).where(s.transcript_id == transcript_id, *conditions).order_by(s.version.desc()).limit(1)


async def current_version(conn: AsyncConnection, transcript_id: UUID) -> Row | None:
    """The current version: the completed one with the highest `version`."""
    return (await conn.execute(_latest(transcript_id, t.summaries.c.status == "done"))).mappings().first()


async def generated_version(conn: AsyncConnection, transcript_id: UUID) -> Row | None:
    """The reference generated version: the most recent completed `generated`."""
    s = t.summaries.c
    return (await conn.execute(_latest(transcript_id, s.status == "done", s.origin == "generated"))).mappings().first()


async def summary_state(conn: AsyncConnection, transcript_id: UUID) -> dict[str, Any]:
    """Schema `SummaryState`: the current one, the reference generated one, the open generation and the total."""
    s = t.summaries.c
    pending = (await conn.execute(_latest(transcript_id, s.status.in_(["queued", "running"])))).mappings().first()
    count = (await conn.execute(select(func.count()).where(s.transcript_id == transcript_id))).scalar_one()
    current, generated = await current_version(conn, transcript_id), await generated_version(conn, transcript_id)
    return {
        "current": summary_json(current) if current else None,
        "generated": summary_json(generated) if generated else None,
        "pending": summary_json(pending) if pending else None,
        "version_count": count,
    }


async def touch_recording(conn: AsyncConnection, transcript_id: UUID) -> None:
    """Moves `updated_at` of the recording and the transcript when the current summary changes.

    The `?since=` of `GET /recordings` and `GET /transcripts` is how the desktop notices that the
    synced folder needs a new summary; without this a redone summary would go unnoticed.
    """
    now = func.now()
    recording_id = (
        update(t.transcripts)
        .where(t.transcripts.c.id == transcript_id)
        .values(updated_at=now)
        .returning(t.transcripts.c.recording_id)
    )
    row = (await conn.execute(recording_id)).first()
    if row is not None:
        await conn.execute(update(t.recordings).where(t.recordings.c.id == row[0]).values(updated_at=now))


async def add_version(  # noqa: PLR0913 — the version is born from the transcript, the content and who made it
    conn: AsyncConnection,
    *,
    transcript: Row,
    content_md: str,
    origin: str,
    base: Row | None,
    created_by: UUID,
    restored_from_id: UUID | None = None,
    agent: tuple[Row, str] | None = None,
    chat_message_id: UUID | None = None,
) -> Row:
    """Inserts an already completed version (`manual` or `chat`), under the caller's `lock_versions`.

    The agenda type is that of the version it started from (`base`); `agent` is the (provider, model)
    pair of a `chat` version.
    """
    provider, model = agent if agent is not None else (None, None)
    values: dict[str, Any] = {
        "owner_id": transcript["owner_id"],
        "transcript_id": transcript["id"],
        "transcript_revision": transcript["revision"],
        "agenda_type_id": base["agenda_type_id"] if base else None,
        "agenda_type_name": base["agenda_type_name"] if base else None,
        "version": await next_version(conn, transcript["id"]),
        "origin": origin,
        "status": "done",
        "trigger": "manual",
        "provider_id": provider["id"] if provider else None,
        "provider_name": provider["name"] if provider else None,
        "provider_kind": provider["kind"] if provider else None,
        "model": model,
        "content_md": content_md,
        "restored_from_id": restored_from_id,
        "chat_message_id": chat_message_id,
        "created_by": created_by,
        "completed_at": func.now(),
    }
    created = (await conn.execute(insert(t.summaries).values(**values).returning(t.summaries))).mappings().one()
    await touch_recording(conn, transcript["id"])
    return created


async def edit_summary(
    conn: AsyncConnection, transcript: Row, content_md: str, base_version: int, created_by: UUID
) -> Row:
    """The hand edit: a `manual` version over the current one; another version in between → 409 `summary_changed`."""
    await lock_versions(conn, transcript["id"])
    current = await current_version(conn, transcript["id"])
    if base_version != (current["version"] if current else 0):
        raise conflict(
            "The summary changed since the opened version; open the current one and edit again.", code=SUMMARY_CHANGED
        )
    return await add_version(
        conn, transcript=transcript, content_md=content_md, origin="manual", base=current, created_by=created_by
    )


async def edit_current(conn: AsyncConnection, transcript: Row, content_md: str, created_by: UUID) -> Row:
    """Edit over the current version, without `base_version` (the MCP server): a `manual` version."""
    await lock_versions(conn, transcript["id"])
    current = await current_version(conn, transcript["id"])
    return await add_version(
        conn, transcript=transcript, content_md=content_md, origin="manual", base=current, created_by=created_by
    )


async def revert_summary(conn: AsyncConnection, transcript: Row, created_by: UUID) -> Row:
    """Revert to generated: a `manual` version with the content of the reference generated one."""
    await lock_versions(conn, transcript["id"])
    generated = await generated_version(conn, transcript["id"])
    if generated is None:
        raise conflict("There is no generated version to go back to.", code=SUMMARY_MISSING)
    return await add_version(
        conn,
        transcript=transcript,
        content_md=generated["content_md"],
        origin="manual",
        base=generated,
        created_by=created_by,
        restored_from_id=generated["id"],
    )


async def delete_all(conn: AsyncConnection, transcript: Row) -> None:
    """Deletes every version and the adjustment chat of the recording."""
    chat = t.summary_chat_messages.c
    await conn.execute(delete(t.summary_chat_messages).where(chat.recording_id == transcript["recording_id"]))
    await conn.execute(delete(t.summaries).where(t.summaries.c.transcript_id == transcript["id"]))


# --- automatic summary ---------------------------------------------------------------------------


async def start_auto_summary(conn: AsyncConnection, recording_id: UUID, revision: int) -> UUID | None:
    """Opens the revision's automatic summary, from the instructions of the recording's agenda type.

    Serves the worker chain (connection role) and the manual type change (under the owner's RLS).
    Without a type or without a `summaries` provider, the `summary` step ends skipped. When the
    automatic summary of the same revision and the same type already exists (a repeated step, or the
    type chosen again), nothing is created. Returns the summary to enqueue.
    """
    recording = (await conn.execute(select(t.recordings).where(t.recordings.c.id == recording_id))).mappings().one()
    transcript = (
        (await conn.execute(select(t.transcripts).where(t.transcripts.c.recording_id == recording_id)))
        .mappings()
        .first()
    )
    agenda_type = None
    if recording["agenda_type_id"] is not None:
        agenda_type = (
            (await conn.execute(select(t.agenda_types).where(t.agenda_types.c.id == recording["agenda_type_id"])))
            .mappings()
            .first()
        )
    if transcript is None or agenda_type is None:
        await set_step(conn, recording, revision, "summary", "skipped", detail={"reason": "no_agenda_type"})
        return None
    await lock_versions(conn, transcript["id"])
    s = t.summaries.c
    existing = await conn.execute(
        select(s.id).where(
            s.transcript_id == transcript["id"],
            s.transcript_revision == transcript["revision"],
            s.agenda_type_id == agenda_type["id"],
            s.trigger == "automatic",
        )
    )
    if existing.first() is not None:
        return None
    provider = await provider_for(conn, "summaries")
    if provider is None:
        await set_step(conn, recording, revision, "summary", "skipped", detail={"reason": "no_provider"})
        return None
    row = await create_summary(
        conn,
        transcript=transcript,
        agenda_type=agenda_type,
        provider=provider,
        trigger="automatic",
        created_by=recording["owner_id"],
    )
    await set_step(conn, recording, revision, "summary", "active", detail={"summary_id": str(row["id"])})
    return row["id"]


async def _finish_step(
    conn: AsyncConnection, summary_id: UUID, state: str, error: tuple[str, str] | None, reason: str | None = None
) -> None:
    """Closes the `summary` step of the revision whose automatic summary this is (if it is); `reason` if skipped."""
    ps = t.pipeline_steps.c
    values: dict[str, Any] = {
        "state": state,
        "finished_at": func.now(),
        "error_code": error[0] if error else None,
        "error_message": error[1] if error else None,
    }
    if reason is not None:
        values["detail"] = ps.detail.op("||")(func.jsonb_build_object("reason", reason))
    closed = await conn.execute(
        update(t.pipeline_steps)
        .where(ps.step == "summary", ps.state == "active", ps.detail["summary_id"].astext == str(summary_id))
        .values(**values)
        .returning(ps.recording_id)
    )
    recording_id = closed.scalar_one_or_none()
    if recording_id is not None and state in UNSUMMARIZED:
        await mark_recording_changed(conn, recording_id)


# --- the `summarize` job ---------------------------------------------------------------------------

MAX_ATTEMPTS = 3
RETRY_DELAYS_S = (30, 120)
GPU_RETRY_S = 60
OLLAMA_WAIT_S = 2 * 3600
# Below the arq `timeout` (30 min), so the summary ends `failed` and not stuck in `running`.
JOB_TIMEOUT_S = 25 * 60
INTERNAL_ERROR = "internal_error"


def provider_config(settings: Settings, row: Row, platform_key_encrypted: str | None = None) -> ProviderConfig:
    """Provider configuration with the decrypted key; without its own key, the platform's applies."""
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


async def transcript_text(conn: AsyncConnection, transcript_id: UUID) -> TranscriptText:
    """The transcript ready for the prompt (title, date, participants and timed utterances)."""
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
    marks = (
        await conn.execute(
            select(t.markers.c.at_ms, t.markers.c.note)
            .join(t.transcripts, t.transcripts.c.recording_id == t.markers.c.recording_id)
            .where(t.transcripts.c.id == transcript_id, t.markers.c.note.is_not(None))
        )
    ).all()
    return render_transcript(
        notes=[(at_ms, note) for at_ms, note in marks],
        title=head["title"],
        recorded_at=head["recorded_at"].strftime("%d/%m/%Y"),
        speakers={row.speaker_id: row.label for row in speakers},
        segments=[(speaker_id, start_ms, text_) for speaker_id, start_ms, text_ in segments],
    )


async def _update_open(engine: AsyncEngine, summary_id: UUID, **values: Any) -> None:  # noqa: ANN401
    """Updates the summary if it still exists and is open (the owner may have deleted it)."""
    async with system_tx(engine) as conn:
        await conn.execute(
            update(t.summaries)
            .where(t.summaries.c.id == summary_id, t.summaries.c.status.in_(["queued", "running"]))
            .values(**values)
        )


async def fail_summary(engine: AsyncEngine, summary_id: UUID, code: str, message: str, attempts: int) -> str:
    """Marks the open summary as failed and closes its `summary` step (the job and the resume)."""
    await _update_open(
        engine,
        summary_id,
        status="failed",
        error_code=code,
        error_message=message,
        attempts=attempts,
        completed_at=func.now(),
    )
    async with system_tx(engine) as conn:
        await _finish_step(conn, summary_id, "failed", (code, message))
    log.warning("summary %s failed: %s — %s", summary_id, code, message)
    return f"falhou: {code}"


async def load_provider(conn: AsyncConnection, provider_id: UUID) -> tuple[Row | None, str | None]:
    """The provider with the encrypted key (connection role) and the platform secret it uses.

    Only `anthropic` without its own key uses one: the `anthropic_api_key`.
    """
    row = (
        (await conn.execute(select(t.agent_providers).where(t.agent_providers.c.id == provider_id))).mappings().first()
    )
    platform_key = None
    if row is not None and row["kind"] == "anthropic" and not row["api_key_encrypted"]:
        platform_key = await secret_encrypted(conn, ANTHROPIC_API_KEY)
    return row, platform_key


def next_try(ctx: dict[str, Any], exc: ProviderError, *, attempts: int, waited_s: float, options: dict) -> float | None:
    """In how many seconds to retry, or `None` (permanent failure).

    The rules of every agent job (summary, fields, detection): a transient failure retries up to
    `MAX_ATTEMPTS`, and a busy GPU (Ollama) postpones without spending an attempt up to `ollama_wait_s`.
    """
    if exc.code == GPU_BUSY:
        wait = options.get("ollama_wait_s", OLLAMA_WAIT_S)
        if isinstance(wait, int | float) and waited_s < wait:
            return ctx.get("gpu_retry_s", GPU_RETRY_S)
        return None
    if exc.retryable and attempts < MAX_ATTEMPTS:
        delays = ctx.get("retry_delays", RETRY_DELAYS_S)
        return delays[min(attempts, len(delays)) - 1]
    return None


@dataclass(frozen=True)
class AgentStep:
    """A pipeline step done by an agent: the recording, the revision, the step and the previous state."""

    recording: Row
    revision: int
    step: str
    started_at: datetime | None
    detail: dict[str, Any]


async def call_agent_step[T](
    ctx: dict[str, Any],
    step: AgentStep,
    provider: tuple[Row, str | None],
    call: Callable[[Provider], Awaitable[T]],
) -> T | str:
    """Calls the agent of a step: the result, or the failure outcome, already written on the step.

    A transient failure goes back to the queue (`arq.Retry`, with the attempts in the step's `detail`);
    a permanent one leaves the step `failed`, and the caller continues the chain. `provider` is the pair
    of `load_provider`.
    """
    engine: AsyncEngine = ctx["engine"]
    try:
        config = provider_config(ctx["settings"], *provider)
    except SecretDecryptError:
        error = (PROVIDER_NOT_CONFIGURED, "A chave de API do provider não abre com a chave de cifra atual.")
        async with system_tx(engine) as conn:
            await set_step(conn, step.recording, step.revision, step.step, "failed", error=error)
        return f"falhou: {error[0]}"
    try:
        async with asyncio.timeout(JOB_TIMEOUT_S):
            return await call(provider_factory(ctx)(config))
    except ProviderError as exc:
        attempts = step.detail.get("attempts", 0) + (exc.code != GPU_BUSY)
        waited = (datetime.now(UTC) - (step.started_at or datetime.now(UTC))).total_seconds()
        defer = next_try(ctx, exc, attempts=attempts, waited_s=waited, options=config.options)
        detail = {**step.detail, "attempts": attempts}
        state, error = ("active", None) if defer is not None else ("failed", (exc.code, exc.message))
        async with system_tx(engine) as conn:
            await set_step(
                conn,
                step.recording,
                step.revision,
                step.step,
                state,
                error=error,
                detail=detail,
                started_at=step.started_at,
            )
        if defer is not None:
            # Outside the transaction: the `Retry` inside it would undo the attempt count.
            raise Retry(defer=defer) from exc
        return f"falhou: {exc.code}"
    except TimeoutError:
        error = (PROVIDER_TIMEOUT, f"A etapa passou de {JOB_TIMEOUT_S // 60} min.")
    except Exception as exc:
        log.exception("step %s of %s: unexpected failure", step.step, step.recording["id"])
        error = (INTERNAL_ERROR, type(exc).__name__)
    async with system_tx(engine) as conn:
        await set_step(conn, step.recording, step.revision, step.step, "failed", error=error)
    return f"falhou: {error[0]}"


def provider_factory(ctx: dict[str, Any]) -> Callable[[ProviderConfig], Provider]:
    """The worker's provider factory (`ctx["provider_factory"]` in the tests)."""
    return ctx.get("provider_factory") or _default_factory(ctx)


def _default_factory(ctx: dict[str, Any]) -> Callable[[ProviderConfig], Provider]:
    async def gpu_idle() -> bool:
        return await ctx["redis"].zcard(GPU_QUEUE) == 0

    settings: Settings = ctx["settings"]
    return lambda config: build_provider(config, claude_bin=settings.claude_bin, gpu_idle=gpu_idle)


async def run_summary(ctx: dict[str, Any], summary_id: UUID) -> str:  # noqa: PLR0911 — one outcome per job path
    """The `summarize` job: generates the summary and writes `done` or `failed`; a transient failure requeues.

    `ctx` is the arq worker's: `engine`, `settings` and `redis`, and — in the tests — `provider_factory`,
    `retry_delays` and `gpu_retry_s`.
    """
    engine: AsyncEngine = ctx["engine"]
    async with system_tx(engine) as conn:
        summary = (
            (await conn.execute(select(t.summaries).where(t.summaries.c.id == summary_id).with_for_update()))
            .mappings()
            .first()
        )
        if summary is None:
            # Deleted before generating: the automatic summary's step does not stay `active` forever.
            await _finish_step(conn, summary_id, "skipped", None, reason="summary_deleted")
            return "resumo apagado"
        if summary["status"] not in {"queued", "running"}:
            return f"resumo já {summary['status']}"
        provider_row, platform_key = await load_provider(conn, summary["provider_id"])
        transcript = await transcript_text(conn, summary["transcript_id"])
        locale = await job_locale(conn, summary["owner_id"])
        await conn.execute(
            update(t.summaries)
            .where(t.summaries.c.id == summary_id)
            .values(status="running", started_at=func.coalesce(t.summaries.c.started_at, func.now()))
        )
    attempts = summary["attempts"] + 1
    if provider_row is None or not provider_row["enabled"]:
        return await fail_summary(
            engine, summary_id, PROVIDER_NOT_CONFIGURED, "O provider foi removido ou desabilitado.", attempts
        )
    try:
        config = provider_config(ctx["settings"], provider_row, platform_key)
    except SecretDecryptError:
        message = "A chave de API do provider não abre com a chave de cifra atual; cadastre-a de novo."
        return await fail_summary(engine, summary_id, PROVIDER_NOT_CONFIGURED, message, attempts)
    factory = provider_factory(ctx)
    try:
        async with asyncio.timeout(JOB_TIMEOUT_S):
            completion = await summarize(factory(config), transcript, summary["instructions"], locale=locale)
    except TimeoutError:
        message = f"O resumo passou de {JOB_TIMEOUT_S // 60} min."
        return await fail_summary(engine, summary_id, PROVIDER_TIMEOUT, message, attempts)
    except ProviderError as exc:
        return await _on_error(ctx, summary, config, exc, attempts)
    except Exception:
        log.exception("summary %s: unexpected failure", summary_id)
        return await fail_summary(engine, summary_id, INTERNAL_ERROR, "Falha inesperada ao gerar o resumo.", attempts)
    async with system_tx(engine) as conn:
        await lock_versions(conn, summary["transcript_id"])
        values: dict[str, Any] = {
            "status": "done",
            "content_md": completion.text,
            "model": completion.model,
            "attempts": attempts,
            "error_code": None,
            "error_message": None,
            "completed_at": func.now(),
        }
        # An edit or an adjustment that arrived during generation took a higher number: the
        # requested generation takes the next one when it finishes, to become the current one.
        following = await next_version(conn, summary["transcript_id"])
        if following > summary["version"] + 1:
            values["version"] = following
        s = t.summaries.c
        finished = await conn.execute(
            update(t.summaries).where(s.id == summary_id, s.status.in_(["queued", "running"])).values(**values)
        )
        if finished.rowcount:
            await touch_recording(conn, summary["transcript_id"])
        await _finish_step(conn, summary_id, "done", None)
    return "done"


async def _on_error(
    ctx: dict[str, Any], summary: Row, config: ProviderConfig, exc: ProviderError, attempts: int
) -> str:
    """Postpones (GPU queue), retries (transient failure) or fails for good."""
    engine: AsyncEngine = ctx["engine"]
    summary_id = summary["id"]
    waited = (datetime.now(UTC) - summary["created_at"]).total_seconds()
    defer = next_try(ctx, exc, attempts=attempts, waited_s=waited, options=config.options)
    if defer is not None:
        # Waiting for the GPU is not an attempt: the provider was not even called.
        spent = attempts if exc.code != GPU_BUSY else summary["attempts"]
        await _update_open(engine, summary_id, status="queued", attempts=spent)
        log.info("summary %s: attempt %d failed (%s), retrying", summary_id, attempts, exc.code)
        raise Retry(defer=defer)
    if exc.code == GPU_BUSY:
        return await fail_summary(
            engine, summary_id, GPU_BUSY, "A fila da GPU não esvaziou a tempo para o Ollama.", attempts
        )
    return await fail_summary(engine, summary_id, exc.code, exc.message, attempts)
