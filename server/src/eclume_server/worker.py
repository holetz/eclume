"""Workers CPU do server: `eclume:default` (`WorkerSettings`) e `eclume:agents` (`AgentWorkerSettings`).

O de `eclume:default` consome o que o worker GPU enfileira ao fim de um `transcribe` —
`ingest_transcript` e `transcription_failed` —, purga os embeddings e roda os crons: descarta
uploads vencidos e marca como falha recuperável o job de transcrição que o worker GPU abandonou e a
resposta do chat que nenhum job vai terminar (`reap_stalled_jobs`), e relança a etapa por agente
ou o resumo que nunca chegou à fila (`resume_pipelines`). O de `eclume:agents`
(`ECLUME_AGENT_MAX_JOBS` vagas) roda as etapas por agente do pipeline (`detect_agenda_type`,
`fill_fields` e o resumo automático), gera os resumos (`summarize`), responde os chats e as
pré-visualizações: a ingestão nunca espera atrás de uma chamada a agente. Contrato em
docs/standards/api/jobs-transcricao.md e docs/standards/code/processamento-automatico.md.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import UUID

from arq import Retry, cron
from arq.connections import RedisSettings
from arq.worker import func
from sqlalchemy import delete, select, update

from eclume_engines.fila import desserializar
from eclume_engines.registro import configurar_logs, contexto_do_job
from eclume_server.agenda_types import ensure_type, run_detect
from eclume_server.agent_actions import run_agent_action_job
from eclume_server.agent_sessions import run_agent_turn_job
from eclume_server.base_chat import run_base_chat_job
from eclume_server.config import Settings, get_settings
from eclume_server.db import tables as t
from eclume_server.db.session import make_engine, system_tx
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
# Vagas do worker de `eclume:default` (o padrão do arq, explícito): só ingestão, falhas e varreduras.
DEFAULT_MAX_JOBS = 10
DEFAULT_POLL_DELAY_S = 2.0
AGENT_POLL_DELAY_S = 1.0
# Falha passageira de Postgres ou S3 nos jobs de retorno do worker GPU: 3 novas tentativas com
# espera crescente (315 s no total, abaixo de `job_stall_seconds`, para o reaper não decidir antes).
INGEST_RETRY_DELAYS_S = (15, 60, 240)
RETURN_MAX_TRIES = len(INGEST_RETRY_DELAYS_S) + 1
# Códigos de pareamento vencidos sem uso somem depois disso (cron `expire_pairing_codes`).
PAIRING_RETENTION = timedelta(days=1)
# Sessões (de usuário e de admin) vencidas há mais disso somem (cron `purge_expired`).
SESSION_RETENTION = timedelta(days=1)
# Uploads terminais com mais disso somem: um app que retome depois recebe 404 e abre outro, que cai
# no dedup por hash da gravação.
UPLOAD_RETENTION = timedelta(days=30)
TERMINAL_UPLOADS = ("completed", "deduplicated", "aborted", "expired")


async def startup(ctx: dict[str, Any]) -> None:
    """Log, engine e storage do processo; `ctx["settings"]` substitui o ambiente (testes)."""
    configurar_logs()
    settings: Settings = ctx.get("settings") or get_settings()
    ctx["settings"] = settings
    ctx["engine"] = make_engine(settings.database_url)
    ctx["storage"] = Storage(settings)


async def shutdown(ctx: dict[str, Any]) -> None:
    """Fecha o pool do banco."""
    await ctx["engine"].dispose()


async def job_start(ctx: dict[str, Any]) -> None:
    """Põe `job_id`, `recording_id` e `revision` no contexto de log do job que vai rodar.

    O arq chama isto na task do job, antes da função; o contexto vale só para aquele job.
    """
    contexto_do_job(ctx.get("job_id"))


async def ingest_transcript(
    ctx: dict[str, Any],
    recording_id: str,
    transcript_key: str,
    embeddings_key: str | None,
    engine_info: dict[str, Any] | None,
) -> str:
    """Persiste a transcrição produzida pelo worker GPU e marca a gravação como `transcribed`.

    A revisão vem do `_job_id` (`ingest_transcript:{recording_id}:{revision}`); sem ela (worker
    antigo), vale o job mais recente. A mensagem de uma revisão que não está mais em aberto é
    ignorada. Uma ingestão que falha desfaz a transação inteira; numa transação nova, o job e a
    gravação viram falha recuperável `ingest_failed`, para a gravação não ficar presa na fila.
    Só quem fecha o job apaga o hash de progresso. A falha passageira de Postgres ou S3 volta à
    fila antes disso (`INGEST_RETRY_DELAYS_S`); a definitiva, ou a passageira que dura todas as
    tentativas, vira `ingest_failed`.
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
        log.exception("ingest_transcript %s (revisão %s): a ingestão falhou", recording_id, job_revision)
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
        # Excluída durante a transcrição: os artefatos que o worker GPU acabou de gravar não ficam.
        await ctx["storage"].delete_artifacts(recording_id)
    elif outcome.persisted:
        await _keep_only_revision(ctx["storage"], recording_id, outcome.revision)
        # A cadeia por agente começa pelo tipo, só quando esta ingestão gravou a transcrição e nenhum
        # locutor espera ser nomeado (a rota que o nomeia enfileira o tipo).
        if not outcome.waiting:
            await _enqueue_step(ctx, "detect_agenda_type", recording_id, revision)
    log.info("ingest_transcript %s: %s", recording_id, outcome.message)
    # A GPU ficou livre para esta conta: o próximo job retido dela entra na fila.
    await next_for_recording(ctx["engine"], ctx["redis"], recording_id)
    return outcome.message


def _retry_if_transient(ctx: dict[str, Any], job: str, recording_id: str, exc: Exception) -> None:
    """Levanta `Retry` (fora da transação) se a falha é passageira e ainda há tentativa."""
    delays = ctx.get("ingest_retry_delays", INGEST_RETRY_DELAYS_S)
    attempt = ctx.get("job_try", 1)
    if attempt <= len(delays) and is_transient(exc):
        log.warning(
            "%s %s: falha passageira na tentativa %d (%s: %s); tenta de novo",
            job,
            recording_id,
            attempt,
            type(exc).__name__,
            exc,
        )
        raise Retry(defer=delays[attempt - 1]) from exc


async def _keep_only_revision(storage: Storage, recording_id: str, revision: int | None) -> None:
    """Depois do commit, o bucket guarda só os artefatos da revisão gravada; falhar aqui só vai ao log.

    O que sobrar sai na próxima ingestão ou na exclusão da gravação.
    """
    if revision is None:
        return
    try:
        await storage.delete_other_revisions(recording_id, revision)
    except Exception:
        log.exception("ingest_transcript %s: a limpeza das outras revisões falhou", recording_id)


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
    """Roda a etapa por agente; uma falha inesperada fora da chamada ao agente deixa a etapa `failed`.

    O `Retry` (falha passageira do agente) volta à fila como sempre; o resto vira `internal_error`,
    e quem chamou segue a cadeia.
    """
    try:
        return await run(ctx, UUID(recording_id), revision)
    except Retry:
        raise
    except Exception as exc:
        log.exception("etapa %s de %s (revisão %d): falha inesperada", step, recording_id, revision)
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
    """Escolhe e aplica o tipo de agenda da revisão (ou o de reserva) e segue para os campos."""
    result = await _run_step(ctx, "agenda_type", recording_id, revision, run_detect)
    if result not in {GONE, STALE}:
        # Pulada ou falha, a gravação fica com o tipo de reserva: o resumo sempre tem um tipo. Nem uma
        # falha aqui para a cadeia.
        try:
            async with system_tx(ctx["engine"]) as conn:
                await ensure_type(conn, UUID(recording_id))
        except Exception:
            log.exception("detect_agenda_type %s: o tipo de reserva não foi aplicado", recording_id)
        await _enqueue_step(ctx, "fill_fields", recording_id, revision)
    log.info("detect_agenda_type %s (revisão %d): %s", recording_id, revision, result)
    return result


async def fill_fields(ctx: dict[str, Any], recording_id: str, revision: int) -> str:
    """Preenche os campos automáticos da revisão e abre o resumo automático pelo tipo."""
    result = await _run_step(ctx, "fields", recording_id, revision, run_fill_fields)
    if result not in {GONE, STALE}:
        async with system_tx(ctx["engine"]) as conn:
            summary_id = await start_auto_summary(conn, UUID(recording_id), revision)
        if summary_id is not None:
            await enqueue_summary(ctx["redis"], summary_id)
            result += f"; resumo automático {summary_id} na fila"
    log.info("fill_fields %s (revisão %d): %s", recording_id, revision, result)
    return result


async def transcription_failed(
    ctx: dict[str, Any], recording_id: str, error_code: str, message: str, stage: str | None = None
) -> str:
    """Marca o job da revisão e a gravação como falhos; `stage` (worker novo) diz a etapa que falhou.

    A revisão vem do `_job_id` (`transcription_failed:{recording_id}:{revision}`), como na ingestão.
    A falha passageira de Postgres volta à fila como na ingestão; esgotadas as tentativas, relança, e
    o reaper cobre o job.
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
    log.info("transcription_failed %s (revisão %s): %s", recording_id, revision, result.message)
    await next_for_recording(ctx["engine"], ctx["redis"], recording_id)
    return result.message


async def purge_embedding_objects(ctx: dict[str, Any], owner_id: str | None = None) -> int:
    """Apaga do bucket os `speaker_embeddings.json`: de toda a plataforma ou só da conta.

    Sem dono (voz desligada na plataforma), lista `recordings/`: alcança toda revisão e as chaves
    antigas sem revisão; nada é apagado se a identificação por voz tiver sido religada nesse
    meio-tempo. Com dono (a conta deixou de guardar amostras), só as gravações da conta, e nada se
    ela voltou a guardar. Um job antigo, sem argumento, segue valendo para a plataforma.
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
    """Gera um resumo (docs/standards/code/server-agentes.md)."""
    result = await run_summary(ctx, UUID(summary_id))
    log.info("summarize %s: %s", summary_id, result)
    return result


async def summary_chat(ctx: dict[str, Any], message_id: str) -> str:
    """Responde um pedido do chat de ajuste do resumo (docs/standards/code/server-agentes.md)."""
    result = await run_summary_chat(ctx, UUID(message_id))
    log.info("summary_chat %s: %s", message_id, result)
    return result


async def agent_turn(
    ctx: dict[str, Any],
    message_id: str,
    transcripts: bool = True,  # noqa: FBT001, FBT002
    scopes: list[str] | None = None,
) -> str:
    """Responde uma pergunta do Agente (docs/standards/code/server-agentes.md §Agente)."""
    result = await run_agent_turn_job(ctx, message_id, transcripts, scopes)
    log.info("agent_turn %s: %s", message_id, result)
    return result


async def agent_action(ctx: dict[str, Any], action_id: str, attempt: int = 0) -> str:
    """Executa uma ação confirmada do Agente, alvo a alvo (docs/standards/code/server-agentes.md §Agente)."""
    result = await run_agent_action_job(ctx, action_id, attempt)
    log.info("agent_action %s: %s", action_id, result)
    return result


async def base_chat(ctx: dict[str, Any], chat_id: str) -> str:
    """Responde uma pergunta do chat sobre a base (docs/standards/code/server-agentes.md)."""
    result = await run_base_chat_job(ctx, chat_id)
    log.info("base_chat %s: %s", chat_id, result)
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


async def purge_pairing_codes(conn: AsyncConnection, now: datetime | None = None) -> int:
    """Apaga os códigos de pareamento vencidos sem uso há mais de `PAIRING_RETENTION`.

    Fica aqui, e não em `devices.py`, porque aquele importa `routes` e o worker não carrega a API.
    """
    cutoff = (now or datetime.now(UTC)) - PAIRING_RETENTION
    codes = t.pairing_codes
    result = await conn.execute(delete(codes).where(codes.c.used_at.is_(None), codes.c.expires_at < cutoff))
    return result.rowcount


async def expire_pairing_codes(ctx: dict[str, Any]) -> int:
    """Cron: os códigos vencidos sem uso somem; os usados ficam com o `token_id`."""
    async with system_tx(ctx["engine"]) as conn:
        return await purge_pairing_codes(conn)


async def purge_stale_rows(conn: AsyncConnection, now: datetime | None = None) -> dict[str, int]:
    """Apaga sessões vencidas há mais de `SESSION_RETENTION` e uploads terminais com mais de `UPLOAD_RETENTION`."""
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
    """Cron diário: retenção mínima de sessões e uploads; `api_tokens` ficam (o usuário vê os revogados)."""
    async with system_tx(ctx["engine"]) as conn:
        removed = await purge_stale_rows(conn)
    log.info("purge_expired: %s", removed)
    return sum(removed.values())


async def reap_stalled_jobs(ctx: dict[str, Any]) -> int:
    """Marca como falha os jobs de transcrição e as respostas do chat que ninguém mais vai terminar."""
    reaped = await reap(ctx["engine"], ctx["redis"], ctx["settings"])
    return len(reaped) + await reap_stalled_chats(ctx["engine"])


async def dispatch_transcriptions(ctx: dict[str, Any]) -> int:
    """Rede do despacho na vez da conta: põe na GPU o job retido de quem não tem outro lá."""
    return len(await dispatch_waiting(ctx["engine"], ctx["redis"]))


async def drain_storage_deletions(ctx: dict[str, Any]) -> int:
    """Tira do bucket o que a fila de exclusão guarda (`storage_deletions.py`)."""
    return await drain(ctx["engine"], ctx["storage"])


async def reconcile_storage(ctx: dict[str, Any]) -> int:
    """Põe na fila de exclusão o que está no bucket sem linha no banco há mais de 24 h."""
    return await reconcile(ctx["engine"], ctx["storage"])


async def resume_pipelines(ctx: dict[str, Any]) -> int:
    """Relança as etapas por agente e os resumos que nunca chegaram à fila (`resume.py`)."""
    return len(await resume(ctx["engine"], ctx["redis"]))


def _agent_functions() -> list[Any]:
    return [
        # As tentativas são contadas no banco (`summaries.attempts`); o arq só precisa não
        # desistir antes, e esperar a GPU (Ollama) re-enfileira sem gastar tentativa.
        func(summarize, timeout=SUMMARIZE_TIMEOUT_S, max_tries=SUMMARIZE_MAX_TRIES),
        # As etapas por agente contam as tentativas na `detail` da etapa, como o resumo no banco.
        func(fill_fields, timeout=SUMMARIZE_TIMEOUT_S, max_tries=SUMMARIZE_MAX_TRIES),
        func(detect_agenda_type, timeout=SUMMARIZE_TIMEOUT_S, max_tries=SUMMARIZE_MAX_TRIES),
        func(run_preview, timeout=SUMMARIZE_TIMEOUT_S),
        # Acima do teto do laço, para a resposta terminar `failed` e não presa em `running`; uma
        # nova tentativa só (contada em `summary_chat_messages.attempts`).
        func(summary_chat, timeout=CHAT_TIMEOUT_S + 60, max_tries=3),
        # Sem nova tentativa: o estado vive no Redis e a pessoa pergunta de novo.
        func(base_chat, timeout=CHAT_TIMEOUT_S + 60, max_tries=1),
        # Sem nova tentativa: a resposta termina `failed` e a pessoa pergunta de novo.
        func(agent_turn, timeout=CHAT_TIMEOUT_S + 60, max_tries=1),
        # Até 50 alvos, cada um numa transação curta; o resultado por alvo torna a repetição segura.
        func(agent_action, timeout=AGENT_ACTION_TIMEOUT_S, max_tries=3),
    ]


def worker_settings(settings: Settings) -> dict[str, Any]:
    """Parâmetros do `arq.Worker` de `eclume:default` para esta configuração."""
    return {
        "functions": [
            # Só a falha passageira volta à fila (`Retry`); o resto termina na primeira tentativa.
            func(ingest_transcript, max_tries=RETURN_MAX_TRIES),
            func(transcription_failed, max_tries=RETURN_MAX_TRIES),
            purge_embedding_objects,
        ],
        "cron_jobs": [
            cron(expire_uploads, minute={0, 30}, run_at_startup=False),
            cron(expire_pairing_codes, minute=15, run_at_startup=False, unique=True),
            cron(purge_expired, hour=3, minute=40, run_at_startup=False, unique=True),
            # A cada minuto; `unique` evita duas varreduras sobrepostas com dois workers CPU.
            cron(reap_stalled_jobs, second=0, run_at_startup=False, unique=True),
            # O job retido cujo despacho não veio (reaper, cancelamento, exclusão, janela de minutos).
            cron(dispatch_transcriptions, second=15, run_at_startup=False, unique=True),
            cron(resume_pipelines, minute=set(range(2, 60, 5)), run_at_startup=False, unique=True),
            cron(drain_storage_deletions, second=30, run_at_startup=False, unique=True),
            cron(reconcile_storage, weekday="sun", hour=4, minute=0, run_at_startup=False, unique=True),
        ],
        "queue_name": DEFAULT_QUEUE,
        "max_jobs": DEFAULT_MAX_JOBS,
        # A fila default tem pouco tráfego e as varreduras mais finas são de 15 s: sondar a cada 2 s basta.
        "poll_delay": DEFAULT_POLL_DELAY_S,
        # A chave de health-check do arq (`eclume:default:health-check`) é a sonda da Saúde.
        "health_check_interval": 15,
        "redis_settings": RedisSettings.from_dsn(settings.redis_url),
        "on_startup": startup,
        "on_shutdown": shutdown,
        "on_job_start": job_start,
        "ctx": {"settings": settings},
        # Fase A da fila sem pickle: lê JSON e o pickle antigo sem globais.
        "job_deserializer": desserializar,
    }


def agent_worker_settings(settings: Settings) -> dict[str, Any]:
    """Parâmetros do `arq.Worker` de `eclume:agents`: os jobs por agente, sem crons."""
    return {
        "functions": _agent_functions(),
        "cron_jobs": None,
        "queue_name": AGENT_QUEUE,
        "max_jobs": settings.agent_max_jobs,
        # O Agente é interativo (chat, ações): 1 s de espera pelo primeiro job é o teto aceito.
        "poll_delay": AGENT_POLL_DELAY_S,
        # `eclume:agents:health-check`, a segunda chave da sonda `cpu_worker` da Saúde.
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
    """Entrada do CLI do arq; lê `ECLUME_*` do ambiente na importação."""

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
    """Entrada do CLI do arq para o worker de agentes (`arq eclume_server.worker.AgentWorkerSettings`)."""

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
