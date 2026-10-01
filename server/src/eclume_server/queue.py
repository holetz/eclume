"""Fila arq (Redis) do contrato de jobs: enfileirar `transcribe` e ler o progresso do worker GPU.

Contrato em docs/standards/api/jobs-transcricao.md.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings
from arq.constants import in_progress_key_prefix

from eclume_engines.fila import desserializar

if TYPE_CHECKING:
    from uuid import UUID

GPU_QUEUE = "eclume:gpu"
# Ingestão, falhas do worker GPU, purgas e crons: não divide vaga com chamada a agente.
DEFAULT_QUEUE = "eclume:default"
# Jobs por agente (tipo de agenda, campos, resumo, chats e pré-visualizações), no worker de agentes.
AGENT_QUEUE = "eclume:agents"
# Heartbeat do worker GPU (hash com TTL), lido pela saúde do painel admin.
GPU_HEALTH_KEY = "eclume:gpu:health"
DEFAULT_LANGUAGE = "pt"
AUTO_LANGUAGE = "auto"

# Etapas do worker GPU → `Job.stage` do contrato v1.
_STAGES = {
    "download": "asr",
    "preprocess": "preprocessing",
    "asr": "asr",
    "align": "alignment",
    "diarize": "diarization",
    "embed": "embeddings",
    "upload": "finalizing",
}


def transcribe_job_id(recording_id: UUID | str, revision: int) -> str:
    """`_job_id` do `transcribe`: um por gravação e revisão."""
    return f"transcribe:{recording_id}:{revision}"


def step_job_id(job: str, recording_id: UUID | str, revision: int) -> str:
    """`_job_id` de uma etapa do pipeline (`fill_fields`, `detect_agenda_type`): uma por revisão."""
    return f"{job}:{recording_id}:{revision}"


def summarize_job_id(summary_id: UUID | str) -> str:
    """`_job_id` do `summarize`: um por resumo."""
    return f"summarize:{summary_id}"


def summary_chat_job_id(message_id: UUID | str) -> str:
    """`_job_id` do `summary_chat`: um por resposta do chat."""
    return f"summary_chat:{message_id}"


# Pedido de cancelamento de um `transcribe`, que o worker GPU confere (cooperativo).
CANCEL_TTL_S = 7 * 24 * 3600


def cancel_key(recording_id: UUID | str, revision: int) -> str:
    """Chave que pede ao worker GPU para parar o `transcribe` da revisão."""
    return f"eclume:cancel:{recording_id}:{revision}"


def progress_key(recording_id: UUID | str) -> str:
    """Hash de progresso que o worker GPU grava."""
    return f"eclume:progress:{recording_id}"


def return_revision(job: str, recording_id: UUID | str, job_id: str | None) -> int | None:
    """A revisão do `_job_id` `{job}:{recording_id}:{revision}` de um job de retorno do worker GPU.

    `None` quando o id não tem essa forma (worker antigo, id aleatório do arq): vale a regra antiga,
    o job mais recente da gravação.
    """
    prefix = f"{job}:{recording_id}:"
    if not job_id or not job_id.startswith(prefix):
        return None
    tail = job_id.removeprefix(prefix)
    if not tail.isdigit() or int(tail) < 1:
        return None
    return int(tail)


def progress_of_revision(raw: dict[str, str] | None, revision: int) -> dict[str, str] | None:
    """O hash de progresso, se for da revisão; o hash sem `revision` (worker antigo) vale."""
    if not raw or raw.get("revision", str(revision)) != str(revision):
        return None
    return raw


def transcribe_options(platform: Any, language: str | None) -> dict[str, Any]:  # noqa: ANN401 — linha de platform_settings
    """`options` do `transcribe`, da configuração da plataforma; o worker não lê o banco."""
    asr = platform["asr"]
    diarization = platform["diarization"]
    chosen = language or asr.get("default_language") or DEFAULT_LANGUAGE
    return {
        # O ASR recebe o idioma sem região (`pt-BR` → `pt`); `auto` vira `null`, e a engine detecta.
        "language": None if chosen == AUTO_LANGUAGE else chosen.split("-", 1)[0],
        "min_speakers": diarization.get("min_speakers"),
        "max_speakers": diarization.get("max_speakers"),
        "engine": asr["engine"],
        "model": asr["model"],
        "compute_type": asr["compute_type"],
        "batch_size": asr.get("batch_size"),
        "fallback_model": asr.get("fallback_model"),
        "endpoint_url": asr.get("endpoint_url"),
        "diarize": bool(diarization.get("enabled")),
        "diarization_model": diarization.get("model"),
        # Impressão de voz só com a identificação por voz ligada na plataforma (LGPD).
        "embeddings": bool(platform["voice_identification"].get("enabled")),
        # O tratamento do áudio antes do ASR; um worker antigo ignora a chave.
        "preprocess": platform["preprocessing"],
    }


async def enqueue_summary(pool: ArqRedis, summary_id: UUID | str) -> None:
    """Enfileira o `summarize` de um resumo na fila do worker de agentes."""
    await pool.enqueue_job("summarize", str(summary_id), _job_id=summarize_job_id(summary_id), _queue_name=AGENT_QUEUE)


def job_progress(raw: dict[str, str] | None) -> tuple[str | None, float] | None:
    """`(stage, progress de 0 a 1)` do hash de progresso, ou `None` se o worker ainda não começou."""
    if not raw:
        return None
    try:
        pct = float(raw.get("pct", 0))
    except ValueError:
        pct = 0.0
    return _STAGES.get(raw.get("stage", "")), max(0.0, min(pct, 100.0)) / 100


class Queue:
    """Pool arq compartilhado pela API."""

    def __init__(self, pool: ArqRedis) -> None:
        """Envolve um pool já aberto."""
        self.pool = pool

    @classmethod
    async def connect(cls, redis_url: str) -> Queue:
        """Abre o pool a partir da URL do Redis."""
        # Fase A da fila sem pickle (holetz/eclume#94): lê JSON e pickle sem globais; grava pickle.
        return cls(
            await create_pool(
                RedisSettings.from_dsn(redis_url), default_queue_name=DEFAULT_QUEUE, job_deserializer=desserializar
            )
        )

    async def close(self) -> None:
        """Fecha o pool."""
        await self.pool.aclose()

    async def enqueue_transcribe(
        self, recording_id: UUID, revision: int, audio_key: str, options: dict[str, Any]
    ) -> None:
        """Enfileira `transcribe` na fila da GPU; o mesmo `_job_id` não duplica."""
        await self.pool.enqueue_job(
            "transcribe",
            str(recording_id),
            audio_key,
            options,
            _job_id=transcribe_job_id(recording_id, revision),
            _queue_name=GPU_QUEUE,
        )

    async def enqueue_summarize(self, summary_id: UUID) -> None:
        """Enfileira `summarize` no worker de agentes; um job por resumo."""
        await enqueue_summary(self.pool, summary_id)

    async def enqueue_summary_chat(self, message_id: UUID) -> None:
        """Enfileira `summary_chat` no worker de agentes; um job por resposta do chat."""
        await self.pool.enqueue_job(
            "summary_chat", str(message_id), _job_id=summary_chat_job_id(message_id), _queue_name=AGENT_QUEUE
        )

    async def request_cancel(self, jobs: list[tuple[UUID, int]]) -> None:
        """Pede ao worker GPU para parar os `transcribe` de `(gravação, revisão)`."""
        for recording_id, revision in jobs:
            await self.pool.set(cancel_key(recording_id, revision), "1", ex=CANCEL_TTL_S)

    async def enqueue_purge_embedding_objects(self) -> None:
        """Enfileira a remoção dos `speaker_embeddings.json` da plataforma no worker CPU."""
        await self.pool.enqueue_job("purge_embedding_objects", _queue_name=DEFAULT_QUEUE)

    async def raw_progress(self, recording_ids: list[UUID]) -> dict[UUID, dict[str, str]]:
        """Hashes de progresso publicados pelo worker GPU, por gravação (só os presentes)."""
        if not recording_ids:
            return {}
        pipe = self.pool.pipeline(transaction=False)
        for recording_id in recording_ids:
            pipe.hgetall(progress_key(recording_id))
        raw = await pipe.execute()
        return {
            recording_id: _decode(values) for recording_id, values in zip(recording_ids, raw, strict=True) if values
        }

    async def progress(self, open_jobs: dict[UUID, int]) -> dict[UUID, tuple[str | None, float]]:
        """Progresso publicado pelo worker GPU, por gravação, só o da revisão do job em aberto."""
        raw = await self.raw_progress(list(open_jobs))
        return {
            recording_id: parsed
            for recording_id, values in raw.items()
            if (parsed := job_progress(progress_of_revision(values, open_jobs[recording_id])))
        }

    async def depth(self, queue_name: str) -> tuple[int, int]:
        """`(na fila, rodando)` de uma fila arq: o zset guarda os dois até o job terminar."""
        job_ids = await self.pool.zrange(queue_name, 0, -1)
        if not job_ids:
            return 0, 0
        pipe = self.pool.pipeline(transaction=False)
        for job_id in job_ids:
            pipe.exists(in_progress_key_prefix + job_id.decode())
        running = sum(await pipe.execute())
        return len(job_ids) - running, running

    async def gpu_health(self) -> dict[str, str] | None:
        """Último heartbeat do worker GPU, ou `None` se expirou (worker parado há mais de 45 s)."""
        values = await self.pool.hgetall(GPU_HEALTH_KEY)
        return _decode(values) if values else None


def _decode(values: dict[bytes, bytes]) -> dict[str, str]:
    return {k.decode(): v.decode() for k, v in values.items()}
