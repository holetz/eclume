"""The arq (Redis) queue of the job contract: enqueue `transcribe` and read the GPU worker's progress.

Contract in docs/standards/api/jobs-transcricao.md.
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
# Ingestion, GPU worker failures, purges and crons: it shares no slot with an agent call.
DEFAULT_QUEUE = "eclume:default"
# Agent jobs (agenda type, fields, summary, chats and previews), in the agent worker.
AGENT_QUEUE = "eclume:agents"
# The GPU worker heartbeat (a hash with a TTL), read by the admin panel's health.
GPU_HEALTH_KEY = "eclume:gpu:health"
# `updated_at` of the last heartbeat seen, written by the `reap_stalled_jobs` cron: the "down since".
GPU_LAST_SEEN_KEY = "eclume:gpu:last_seen"
DEFAULT_LANGUAGE = "pt"
AUTO_LANGUAGE = "auto"

# GPU worker stages → contract v1 `Job.stage`.
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
    """The `transcribe` `_job_id`: one per recording and revision."""
    return f"transcribe:{recording_id}:{revision}"


def step_job_id(job: str, recording_id: UUID | str, revision: int) -> str:
    """The `_job_id` of a pipeline step (`fill_fields`, `detect_agenda_type`): one per revision."""
    return f"{job}:{recording_id}:{revision}"


def summarize_job_id(summary_id: UUID | str) -> str:
    """The `summarize` `_job_id`: one per summary."""
    return f"summarize:{summary_id}"


def summary_chat_job_id(message_id: UUID | str) -> str:
    """The `summary_chat` `_job_id`: one per chat reply."""
    return f"summary_chat:{message_id}"


# Cancellation request of a `transcribe`, which the GPU worker checks (cooperative).
CANCEL_TTL_S = 7 * 24 * 3600


def cancel_key(recording_id: UUID | str, revision: int) -> str:
    """Key that asks the GPU worker to stop the revision's `transcribe`."""
    return f"eclume:cancel:{recording_id}:{revision}"


def progress_key(recording_id: UUID | str) -> str:
    """Progress hash the GPU worker writes."""
    return f"eclume:progress:{recording_id}"


def return_revision(job: str, recording_id: UUID | str, job_id: str | None) -> int | None:
    """The revision of the `_job_id` `{job}:{recording_id}:{revision}` of a GPU worker return job.

    `None` when the id does not have that shape (an old worker, a random arq id): the old rule
    holds, the recording's most recent job.
    """
    prefix = f"{job}:{recording_id}:"
    if not job_id or not job_id.startswith(prefix):
        return None
    tail = job_id.removeprefix(prefix)
    if not tail.isdigit() or int(tail) < 1:
        return None
    return int(tail)


def progress_of_revision(raw: dict[str, str] | None, revision: int) -> dict[str, str] | None:
    """The progress hash, if it belongs to the revision; a hash without `revision` (an old worker) counts."""
    if not raw or raw.get("revision", str(revision)) != str(revision):
        return None
    return raw


def _speaker_limits(
    diarization: dict[str, Any], speakers: tuple[int | None, int | None] | None
) -> tuple[int | None, int | None]:
    """The requested `(min, max)` with each empty side filled from the platform limits.

    If filling would invert the pair (min above max), the explicit side wins and the filled one is dropped.
    """
    platform = (diarization.get("min_speakers"), diarization.get("max_speakers"))
    if speakers is None:
        return platform
    low, high = speakers
    if low is not None and high is not None:
        return low, high
    if low is None:
        low = platform[0]
        return (None if low is not None and high is not None and low > high else low), high
    high = platform[1]
    return low, (None if high is not None and low > high else high)


def transcribe_options(
    platform: Any,  # noqa: ANN401 — a platform_settings row
    language: str | None,
    *,
    keep_samples: bool = True,
    speakers: tuple[int | None, int | None] | None = None,
) -> dict[str, Any]:
    """The `transcribe` `options`, from the platform and account settings; the worker does not read the database.

    `speakers` is the `(min, max)` pair of speakers that overrides the admin limits (the note and the request);
    an empty side of the pair keeps the platform limit.
    """
    asr = platform["asr"]
    diarization = platform["diarization"]
    low, high = _speaker_limits(diarization, speakers)
    chosen = language or asr.get("default_language") or DEFAULT_LANGUAGE
    return {
        # ASR receives the language without a region (`pt-BR` → `pt`); `auto` becomes `null`, and the engine detects.
        "language": None if chosen == AUTO_LANGUAGE else chosen.split("-", 1)[0],
        "min_speakers": low,
        "max_speakers": high,
        "engine": asr["engine"],
        "model": asr["model"],
        "compute_type": asr["compute_type"],
        "batch_size": asr.get("batch_size"),
        "fallback_model": asr.get("fallback_model"),
        "endpoint_url": asr.get("endpoint_url"),
        "diarize": bool(diarization.get("enabled")),
        "diarization_model": diarization.get("model"),
        # Voiceprint only with voice identification turned on for the platform and the account keeping
        # samples (LGPD).
        "embeddings": keep_samples and bool(platform["voice_identification"].get("enabled")),
        # The audio processing before ASR; an old worker ignores the key.
        "preprocess": platform["preprocessing"],
    }


async def enqueue_summary(pool: ArqRedis, summary_id: UUID | str) -> None:
    """Enqueue a summary's `summarize` on the agent worker's queue."""
    await pool.enqueue_job("summarize", str(summary_id), _job_id=summarize_job_id(summary_id), _queue_name=AGENT_QUEUE)


def job_progress(raw: dict[str, str] | None) -> tuple[str | None, float] | None:
    """`(stage, progress from 0 to 1)` of the progress hash, or `None` if the worker has not started yet."""
    if not raw:
        return None
    try:
        pct = float(raw.get("pct", 0))
    except ValueError:
        pct = 0.0
    return _STAGES.get(raw.get("stage", "")), max(0.0, min(pct, 100.0)) / 100


class Queue:
    """The arq pool shared by the API."""

    def __init__(self, pool: ArqRedis) -> None:
        """Wrap an already open pool."""
        self.pool = pool

    @classmethod
    async def connect(cls, redis_url: str) -> Queue:
        """Open the pool from the Redis URL."""
        # Phase A of the pickle-free queue (holetz/eclume#94): reads JSON and pickle without globals; writes pickle.
        return cls(
            await create_pool(
                RedisSettings.from_dsn(redis_url), default_queue_name=DEFAULT_QUEUE, job_deserializer=desserializar
            )
        )

    async def close(self) -> None:
        """Close the pool."""
        await self.pool.aclose()

    async def enqueue_summarize(self, summary_id: UUID) -> None:
        """Enqueue `summarize` on the agent worker; one job per summary."""
        await enqueue_summary(self.pool, summary_id)

    async def enqueue_summary_chat(self, message_id: UUID) -> None:
        """Enqueue `summary_chat` on the agent worker; one job per chat reply."""
        await self.pool.enqueue_job(
            "summary_chat", str(message_id), _job_id=summary_chat_job_id(message_id), _queue_name=AGENT_QUEUE
        )

    async def enqueue_step(self, job: str, recording_id: UUID, revision: int) -> None:
        """Enqueue a pipeline agent step (`detect_agenda_type`), by the revision's `_job_id`."""
        await self.pool.enqueue_job(
            job, str(recording_id), revision, _job_id=step_job_id(job, recording_id, revision), _queue_name=AGENT_QUEUE
        )

    async def request_cancel(self, jobs: list[tuple[UUID, int]]) -> None:
        """Ask the GPU worker to stop the `transcribe` jobs of `(recording, revision)`."""
        for recording_id, revision in jobs:
            await self.pool.set(cancel_key(recording_id, revision), "1", ex=CANCEL_TTL_S)

    async def enqueue_purge_embedding_objects(self, owner_id: UUID | None = None) -> None:
        """Enqueue on the CPU worker the removal of the `speaker_embeddings.json` of the platform, or of one account only."""
        args = (str(owner_id),) if owner_id is not None else ()
        await self.pool.enqueue_job("purge_embedding_objects", *args, _queue_name=DEFAULT_QUEUE)

    async def raw_progress(self, recording_ids: list[UUID]) -> dict[UUID, dict[str, str]]:
        """Progress hashes published by the GPU worker, per recording (only those present)."""
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
        """Progress published by the GPU worker, per recording, only that of the open job's revision."""
        raw = await self.raw_progress(list(open_jobs))
        return {
            recording_id: parsed
            for recording_id, values in raw.items()
            if (parsed := job_progress(progress_of_revision(values, open_jobs[recording_id])))
        }

    async def depth(self, queue_name: str) -> tuple[int, int]:
        """`(queued, running)` of an arq queue: the zset holds both until the job finishes."""
        job_ids = await self.pool.zrange(queue_name, 0, -1)
        if not job_ids:
            return 0, 0
        pipe = self.pool.pipeline(transaction=False)
        for job_id in job_ids:
            pipe.exists(in_progress_key_prefix + job_id.decode())
        running = sum(await pipe.execute())
        return len(job_ids) - running, running

    async def gpu_health(self) -> dict[str, str] | None:
        """The GPU worker's last heartbeat, or `None` if it expired (worker stopped for more than 45 s)."""
        values = await self.pool.hgetall(GPU_HEALTH_KEY)
        return _decode(values) if values else None


def _decode(values: dict[bytes, bytes]) -> dict[str, str]:
    return {k.decode(): v.decode() for k, v in values.items()}
