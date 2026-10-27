"""Fakes of the suite: the GPU worker and the summarization agents.

The fake GPU worker fulfils the GPU side of the job contract with the fixture transcript: it publishes
`recordings/{id}/r{revision}/transcript.raw.json` (the 3-speaker fixture without `person`/
`suggestions`, with `Locutor N` labels) and, when asked, `speaker_embeddings.json`; it writes the progress
with the revision and enqueues `ingest_transcript` (or `transcription_failed`) on `eclume:default` with the
`_job_id` of the revision. `legacy=True` plays the old worker: keys without revision, progress without
`revision` and return without `_job_id`. The embeddings have 256
dimensions, like pyannote's: by default, one fixed "voice" per speaker (`voice(1..3)`), the same in
every recording; `voices=` swaps the voices of one round.

`FakeAgents` replaces the provider factory of the agent jobs (`summarize`, `fill_fields`,
`detect_agenda_type`, `summary_chat`):
no test calls a real LLM, and every call is recorded.
"""

from __future__ import annotations

import asyncio
import json
import random
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

from arq.connections import RedisSettings
from arq.worker import Worker, func
from redis.asyncio import Redis

from eclume_server.agents.agent import AGENT_SYSTEM_PREFIX
from eclume_server.agents.base import Completion, ProviderConfig, ProviderError, with_context
from eclume_server.agents.base_chat import BASE_CHAT_SUMMARIES_SYSTEM, BASE_CHAT_SYSTEM
from eclume_server.agents.chat import CHAT_SYSTEM
from eclume_server.agents.extraction import DETECT_SYSTEM, FIELDS_SYSTEM
from eclume_server.queue import AGENT_QUEUE, DEFAULT_QUEUE, GPU_QUEUE, progress_key
from eclume_server.storage import Storage, artifacts_prefix
from eclume_server.worker import agent_worker_settings, worker_settings
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from eclume_server.config import Settings
    from eclume_server_testing.api import Api

FIXTURE = Path(__file__).resolve().parents[3] / "contracts" / "fixtures" / "transcript-3-locutores.json"
EMBEDDING_MODEL = "pyannote/wespeaker-voxceleb-resnet34-LM"
EMBEDDING_DIMS = 256


def voice(seed: int, *, jitter: float = 0.0, jitter_seed: int = 0) -> list[float]:
    """A "voice": Gaussian vector fixed per `seed` (distinct voices are nearly orthogonal), with optional noise."""
    base = random.Random(seed)  # noqa: S311 — test data, no cryptographic purpose
    noise = random.Random(10_000 + jitter_seed)  # noqa: S311
    return [base.gauss(0, 1) + jitter * noise.gauss(0, 1) for _ in range(EMBEDDING_DIMS)]


DEFAULT_VOICES = {f"S{i}": voice(i) for i in (1, 2, 3)}
ENGINE_INFO = {
    "engine": "whisperx-local",
    "model": "large-v3-turbo",
    "compute_type": "int8_float16",
    "diarization_model": "pyannote/speaker-diarization-community-1",
    "duration_ms": 166000,
    "realtime_factor": 0.05,
    "vram_peak_mb": 4100,
}


def contract_transcript() -> dict[str, Any]:
    """The 3-speaker transcript of the contract."""
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def raw_transcript() -> dict[str, Any]:
    """Output of the GPU worker: the transcript schema without persons or suggestions, speakers `Locutor N`."""
    source = contract_transcript()
    return {
        "schema_version": source["schema_version"],
        "language": "pt",
        "duration_ms": source["duration_ms"],
        "engine": source["engine"],
        "speakers": [{"id": s["id"], "label": f"Locutor {s['id'][1:]}"} for s in source["speakers"]],
        "segments": source["segments"],
    }


async def _put_json(storage: Storage, key: str, document: object) -> None:
    """Writes a JSON to the bucket the way the GPU worker does."""
    await asyncio.to_thread(
        storage._s3.put_object,  # noqa: SLF001 — the real worker writes through its own S3 client
        Bucket=storage.bucket,
        Key=key,
        Body=json.dumps(document).encode(),
        ContentType="application/json",
    )


def _return_job_id(ctx: dict[str, Any], job: str, recording_id: str, revision: int) -> dict[str, str]:
    """The return `_job_id` with the revision; the old worker lets arq pick one at random."""
    return {} if ctx.get("legacy") else {"_job_id": f"{job}:{recording_id}:{revision}"}


async def fake_transcribe(ctx: dict[str, Any], recording_id: str, audio_key: str, options: dict[str, Any]) -> str:
    """The `transcribe` of the contract, without a GPU."""
    storage: Storage = ctx["storage"]
    redis = ctx["redis"]
    legacy = bool(ctx.get("legacy"))
    revision = int(str(ctx["job_id"]).rsplit(":", 1)[1])
    progress = {"stage": "upload", "pct": "100", "updated_at": "agora"} | ({} if legacy else {"revision": revision})
    await redis.hset(progress_key(recording_id), mapping=progress)
    await redis.expire(progress_key(recording_id), 86400)
    if ctx.get("fail"):
        code, message = ctx.get("failure") or ("gpu_oom", "CUDA out of memory")
        await redis.enqueue_job(
            "transcription_failed",
            recording_id,
            code,
            message,
            ctx.get("fail_stage", "asr"),
            _queue_name=DEFAULT_QUEUE,
            **_return_job_id(ctx, "transcription_failed", recording_id, revision),
        )
        return "falhou"
    await storage.sha256(audio_key)  # the audio exists and is readable
    prefix = artifacts_prefix(recording_id) + ("" if legacy else f"r{revision}/")
    transcript_key = f"{prefix}transcript.raw.json"
    await _put_json(storage, transcript_key, raw_transcript())
    embeddings_key = None
    if options.get("embeddings"):
        embeddings_key = f"{prefix}speaker_embeddings.json"
        vectors = ctx.get("voices") or DEFAULT_VOICES
        document = {"speaker_embeddings": vectors, "embedding_model": EMBEDDING_MODEL, "dimension": EMBEDDING_DIMS}
        await _put_json(storage, embeddings_key, document)
    # The job started on the worker a moment ago, before the ingestion.
    info = dict(ENGINE_INFO) | {"started_at": (datetime.now(UTC) - timedelta(seconds=5)).isoformat()}
    if "preprocess" in options:
        # The preprocessing done as the settings asked; `preprocess_fallback` simulates the fallback.
        failed = ctx.get("preprocess_fallback", False)
        steps = [
            {"step": name, "state": ("failed" if failed else "done") if block.get("enabled") else "skipped"}
            | ({"error": "arnndn: modelo inválido"} if failed and block.get("enabled") else {})
            for name, block in options["preprocess"].items()
        ]
        info["preprocess"] = {
            "steps": steps,
            "ms": 1500,
            "offset_ms": 0,
            "channels": 1,
            "split": False,
            "fallback": failed,
        }
    await redis.enqueue_job(
        "ingest_transcript",
        recording_id,
        transcript_key,
        embeddings_key,
        info,
        _queue_name=DEFAULT_QUEUE,
        **_return_job_id(ctx, "ingest_transcript", recording_id, revision),
    )
    ctx["calls"].append((recording_id, audio_key, options))
    return "ok"


async def _gpu_startup(ctx: dict[str, Any]) -> None:
    ctx["storage"] = Storage(ctx["settings"])


def run_gpu(
    settings: Settings,
    *,
    fail: bool = False,
    voices: dict[str, list[float]] | None = None,
    **behavior: Any,  # noqa: ANN401
) -> list[tuple[str, str, dict[str, Any]]]:
    """Drains `eclume:gpu` with the fake `transcribe`; returns the calls received.

    `behavior` tunes the fake: `fail_stage` and `failure` (code, message) on failure,
    `preprocess_fallback` for the preprocessing chain fallen back to the format only, and `legacy`
    for the GPU worker from before the revision in the returns.
    """
    calls: list[tuple[str, str, dict[str, Any]]] = []
    ctx: dict[str, Any] = {"settings": settings, "fail": fail, "calls": calls, "voices": voices, **behavior}
    run(
        _drain(
            [func(fake_transcribe, name="transcribe")],
            queue_name=GPU_QUEUE,
            redis_settings=RedisSettings.from_dsn(settings.redis_url),
            on_startup=_gpu_startup,
            ctx=ctx,
            max_jobs=1,
        )
    )
    return calls


def purpose_of(system: str, prompt: str) -> str:
    """The purpose of the call: `fields`, `agenda_detection`, `chat`, `base_chat`, `agent` or `summaries`.

    The fields and the summary share the `system`; the field rules go in the prompt.
    """
    if FIELDS_SYSTEM in prompt:
        return "fields"
    if system.startswith(AGENT_SYSTEM_PREFIX):
        return "agent"
    return {
        DETECT_SYSTEM: "agenda_detection",
        CHAT_SYSTEM: "chat",
        BASE_CHAT_SYSTEM: "base_chat",
        BASE_CHAT_SUMMARIES_SYSTEM: "base_chat",
    }.get(system, "summaries")


@dataclass
class FakeAgents:
    """Factory of fake providers, with replies per purpose and scheduled errors, in order.

    `replies[purpose]` is the reply queue of that purpose, one per call (the chat
    script: queries and the reply); when empty, the default holds: deterministic Markdown for the summary, `{}`
    (nothing found) for the fields, the first type (`T1`) for the detection and a `reply` that leaves the
    summary unchanged for the chat.
    The `errors` apply to any
    call, before the replies; `failures[purpose]` only to those of that purpose.
    """

    errors: list[ProviderError] = field(default_factory=list)
    replies: dict[str, list[str]] = field(default_factory=dict)
    failures: dict[str, list[ProviderError]] = field(default_factory=dict)
    calls: list[tuple[ProviderConfig, str, str]] = field(default_factory=list)

    def of(self, purpose: str) -> list[tuple[ProviderConfig, str, str]]:
        """The calls of one purpose."""
        return [call for call in self.calls if purpose_of(call[1], call[2]) == purpose]

    def __call__(self, config: ProviderConfig) -> _FakeAgent:
        """The fake provider of `config`."""
        return _FakeAgent(self, config)


@dataclass
class _FakeAgent:
    agents: FakeAgents
    config: ProviderConfig

    async def complete(self, system: str, prompt: str, *, context: str = "") -> Completion:
        prompt = with_context(context, prompt)
        self.agents.calls.append((self.config, system, prompt))
        if self.agents.errors:
            raise self.agents.errors.pop(0)
        purpose = purpose_of(system, prompt)
        if self.agents.failures.get(purpose):
            raise self.agents.failures[purpose].pop(0)
        queued = self.agents.replies.get(purpose)
        if queued:
            text = queued.pop(0)
        elif purpose == "fields":
            text = "{}"
        elif purpose == "agenda_detection":
            text = '{"tipo": "T1", "confianca": 0.9, "motivo": "o primeiro tipo"}'
        elif purpose in {"base_chat", "agent"}:
            text = '{"action": "reply", "message": "Pronto.", "sources": []}'
        elif purpose == "chat":
            text = '{"action": "reply", "message": "Pronto.", "summary_md": null}'
        else:
            text = f"# Resumo\n\n- gerado por {self.config.name}"
        return Completion(text=text, model=f"{self.config.model}-fake")


_CPU_ROUNDS = 20


def run_cpu(settings: Settings, agents: FakeAgents | None = None) -> FakeAgents:
    """Drains `eclume:default` and `eclume:agents` with the real CPU workers of the server and fake agents.

    One queue enqueues into the other (the ingestion opens the agent chain), so both workers run
    in a loop until both are empty. Returns the agents.
    """
    agents = agents or FakeAgents()
    for _ in range(_CPU_ROUNDS):
        for make in (worker_settings, agent_worker_settings):
            params = make(settings) | {"cron_jobs": None, "poll_delay": 0.05}
            # No wait between attempts: the worker in burst mode would wait for the postponement in real time.
            params["ctx"] = params["ctx"] | {
                "provider_factory": agents,
                "retry_delays": (0, 0),
                "gpu_retry_s": 0,
                "ingest_retry_delays": (0, 0, 0),
            }
            run(_drain(params.pop("functions"), **params))
        if not run(_pending(settings)):
            return agents
    msg = f"the CPU worker queues did not empty in {_CPU_ROUNDS} rounds"
    raise AssertionError(msg)


async def _pending(settings: Settings) -> int:
    """Jobs still in the CPU worker queues."""
    client = Redis.from_url(settings.redis_url)
    try:
        return sum([await client.zcard(DEFAULT_QUEUE), await client.zcard(AGENT_QUEUE)])
    finally:
        await client.aclose()


async def _drain(functions: list[Any], **params: Any) -> None:  # noqa: ANN401
    # The `Worker` keeps the current loop when created: it must be created inside the loop that runs it.
    worker = Worker(functions, **params, burst=True, max_tries=1, handle_signals=False)
    try:
        await worker.main()
    finally:
        await worker.close()


def drain_storage(settings: Settings) -> None:
    """Empties the bucket deletion queue, as the `drain_storage_deletions` cron would."""
    from eclume_server.db.session import make_engine  # noqa: PLC0415
    from eclume_server.storage_deletions import drain  # noqa: PLC0415

    async def go() -> None:
        engine = make_engine(settings.database_url)
        try:
            while await drain(engine, Storage(settings)):
                pass
        finally:
            await engine.dispose()

    run(go())


def transcribed(
    api: Api,
    settings: Settings,
    *,
    voices: dict[str, list[float]] | None = None,
    **fields: Any,  # noqa: ANN401
) -> dict[str, Any]:
    """Uploads an audio and runs both workers: returns the recording already with the 3-speaker transcript."""
    recording = upload_file(api, audio_bytes(1000), **fields)
    run_gpu(settings, voices=voices)
    run_cpu(settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["status"] == "transcribed", body
    return body
