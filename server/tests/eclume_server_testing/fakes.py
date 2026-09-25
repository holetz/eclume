"""Fakes da suíte: o worker GPU e os agentes de sumarização.

O worker GPU fake cumpre o lado GPU do contrato de jobs com a transcrição de fixture: publica
`recordings/{id}/transcript.raw.json` (a fixture de 3 locutores sem `person`/`suggestions`, com
rótulos `Locutor N`) e, se pedido, `speaker_embeddings.json`; grava o progresso e enfileira
`ingest_transcript` (ou `transcription_failed`) em `eclume:default`.

`FakeAgents` substitui a fábrica de providers do job `summarize`: nenhum teste chama um LLM de
verdade, e cada chamada fica registrada.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from arq.connections import RedisSettings
from arq.worker import Worker, func

from eclume_server.agents.base import Completion, ProviderConfig, ProviderError
from eclume_server.queue import DEFAULT_QUEUE, GPU_QUEUE, progress_key
from eclume_server.storage import Storage, artifacts_prefix
from eclume_server.worker import worker_settings
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from eclume_server.config import Settings
    from eclume_server_testing.api import Api

FIXTURE = Path(__file__).resolve().parents[3] / "contracts" / "fixtures" / "transcript-3-locutores.json"
EMBEDDING_MODEL = "pyannote/wespeaker-voxceleb-resnet34-LM"
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
    """A transcrição de 3 locutores do contrato."""
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def raw_transcript() -> dict[str, Any]:
    """Saída do worker GPU: o schema da transcrição sem pessoas nem sugestões, locutores `Locutor N`."""
    source = contract_transcript()
    return {
        "schema_version": source["schema_version"],
        "language": "pt",
        "duration_ms": source["duration_ms"],
        "engine": source["engine"],
        "speakers": [{"id": s["id"], "label": f"Locutor {s['id'][1:]}"} for s in source["speakers"]],
        "segments": source["segments"],
    }


async def fake_transcribe(ctx: dict[str, Any], recording_id: str, audio_key: str, options: dict[str, Any]) -> str:
    """O `transcribe` do contrato, sem GPU."""
    storage: Storage = ctx["storage"]
    redis = ctx["redis"]
    await redis.hset(progress_key(recording_id), mapping={"stage": "upload", "pct": "100", "updated_at": "agora"})
    await redis.expire(progress_key(recording_id), 86400)
    if ctx.get("fail"):
        await redis.enqueue_job(
            "transcription_failed", recording_id, "gpu_oom", "CUDA out of memory", _queue_name=DEFAULT_QUEUE
        )
        return "falhou"
    await storage.sha256(audio_key)  # o áudio existe e é legível
    prefix = artifacts_prefix(recording_id)
    transcript_key = f"{prefix}transcript.raw.json"
    await storage.put_bytes(transcript_key, json.dumps(raw_transcript()).encode(), "application/json")
    embeddings_key = None
    if options.get("embeddings"):
        embeddings_key = f"{prefix}speaker_embeddings.json"
        vectors = {f"S{i}": [float(i), 0.5, -0.25] for i in (1, 2, 3)}
        document = {"speaker_embeddings": vectors, "embedding_model": EMBEDDING_MODEL}
        await storage.put_bytes(embeddings_key, json.dumps(document).encode(), "application/json")
    await redis.enqueue_job(
        "ingest_transcript", recording_id, transcript_key, embeddings_key, ENGINE_INFO, _queue_name=DEFAULT_QUEUE
    )
    ctx["calls"].append((recording_id, audio_key, options))
    return "ok"


async def _gpu_startup(ctx: dict[str, Any]) -> None:
    ctx["storage"] = Storage(ctx["settings"])


def run_gpu(settings: Settings, *, fail: bool = False) -> list[tuple[str, str, dict[str, Any]]]:
    """Drena `eclume:gpu` com o `transcribe` fake; devolve as chamadas recebidas."""
    calls: list[tuple[str, str, dict[str, Any]]] = []
    ctx: dict[str, Any] = {"settings": settings, "fail": fail, "calls": calls}
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


@dataclass
class FakeAgents:
    """Fábrica de providers falsos: devolve Markdown determinístico ou os erros programados, em ordem."""

    errors: list[ProviderError] = field(default_factory=list)
    calls: list[tuple[ProviderConfig, str, str]] = field(default_factory=list)

    def __call__(self, config: ProviderConfig) -> _FakeAgent:
        """O provider falso de `config`."""
        return _FakeAgent(self, config)


@dataclass
class _FakeAgent:
    agents: FakeAgents
    config: ProviderConfig

    async def complete(self, system: str, prompt: str) -> Completion:
        self.agents.calls.append((self.config, system, prompt))
        if self.agents.errors:
            raise self.agents.errors.pop(0)
        return Completion(text=f"# Resumo\n\n- gerado por {self.config.name}", model=f"{self.config.model}-fake")


def run_cpu(settings: Settings, agents: FakeAgents | None = None) -> FakeAgents:
    """Drena `eclume:default` com o worker CPU real do server e agentes falsos; devolve os agentes."""
    agents = agents or FakeAgents()
    params = worker_settings(settings) | {"cron_jobs": None}
    # Sem espera entre tentativas: o worker em modo burst esperaria o adiamento em tempo real.
    params["ctx"] = params["ctx"] | {"provider_factory": agents, "retry_delays": (0, 0), "gpu_retry_s": 0}
    run(_drain(params.pop("functions"), **params))
    return agents


async def _drain(functions: list[Any], **params: Any) -> None:  # noqa: ANN401
    # O `Worker` guarda o loop corrente ao nascer: precisa ser criado dentro do loop que o roda.
    worker = Worker(functions, **params, burst=True, max_tries=1, handle_signals=False, poll_delay=0.05)
    try:
        await worker.main()
    finally:
        await worker.close()


def transcribed(api: Api, settings: Settings, **fields: Any) -> dict[str, Any]:  # noqa: ANN401
    """Sobe um áudio e roda os dois workers: devolve a gravação já com a transcrição de 3 locutores."""
    recording = upload_file(api, audio_bytes(1000), **fields)
    run_gpu(settings)
    run_cpu(settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["status"] == "transcribed", body
    return body
