"""Fakes da suíte: o worker GPU e os agentes de sumarização.

O worker GPU fake cumpre o lado GPU do contrato de jobs com a transcrição de fixture: publica
`recordings/{id}/transcript.raw.json` (a fixture de 3 locutores sem `person`/`suggestions`, com
rótulos `Locutor N`) e, se pedido, `speaker_embeddings.json`; grava o progresso e enfileira
`ingest_transcript` (ou `transcription_failed`) em `eclume:default`. Os embeddings têm 256
dimensões, como os do pyannote: por padrão, uma "voz" fixa por locutor (`voice(1..3)`), a mesma em
toda gravação; `voices=` troca as vozes de uma rodada.

`FakeAgents` substitui a fábrica de providers dos jobs por agente (`summarize`, `fill_fields`,
`detect_agenda_type`, `summary_chat`):
nenhum teste chama um LLM de verdade, e cada chamada fica registrada.
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

from eclume_server.agents.base import Completion, ProviderConfig, ProviderError, with_context
from eclume_server.agents.base_chat import BASE_CHAT_SYSTEM
from eclume_server.agents.chat import CHAT_SYSTEM
from eclume_server.agents.extraction import DETECT_SYSTEM, FIELDS_SYSTEM
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
EMBEDDING_DIMS = 256


def voice(seed: int, *, jitter: float = 0.0, jitter_seed: int = 0) -> list[float]:
    """Uma "voz": vetor gaussiano fixo por `seed` (vozes distintas são quase ortogonais), com ruído opcional."""
    base = random.Random(seed)  # noqa: S311 — dado de teste, sem fim criptográfico
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


async def _put_json(storage: Storage, key: str, document: object) -> None:
    """Grava um JSON no bucket como o worker GPU faz."""
    await asyncio.to_thread(
        storage._s3.put_object,  # noqa: SLF001 — o worker de verdade grava pelo próprio cliente S3
        Bucket=storage.bucket,
        Key=key,
        Body=json.dumps(document).encode(),
        ContentType="application/json",
    )


async def fake_transcribe(ctx: dict[str, Any], recording_id: str, audio_key: str, options: dict[str, Any]) -> str:
    """O `transcribe` do contrato, sem GPU."""
    storage: Storage = ctx["storage"]
    redis = ctx["redis"]
    await redis.hset(progress_key(recording_id), mapping={"stage": "upload", "pct": "100", "updated_at": "agora"})
    await redis.expire(progress_key(recording_id), 86400)
    if ctx.get("fail"):
        code, message = ctx.get("failure") or ("gpu_oom", "CUDA out of memory")
        await redis.enqueue_job(
            "transcription_failed", recording_id, code, message, ctx.get("fail_stage", "asr"), _queue_name=DEFAULT_QUEUE
        )
        return "falhou"
    await storage.sha256(audio_key)  # o áudio existe e é legível
    prefix = artifacts_prefix(recording_id)
    transcript_key = f"{prefix}transcript.raw.json"
    await _put_json(storage, transcript_key, raw_transcript())
    embeddings_key = None
    if options.get("embeddings"):
        embeddings_key = f"{prefix}speaker_embeddings.json"
        vectors = ctx.get("voices") or DEFAULT_VOICES
        document = {"speaker_embeddings": vectors, "embedding_model": EMBEDDING_MODEL, "dimension": EMBEDDING_DIMS}
        await _put_json(storage, embeddings_key, document)
    # O job começou no worker há pouco, antes da ingestão.
    info = dict(ENGINE_INFO) | {"started_at": (datetime.now(UTC) - timedelta(seconds=5)).isoformat()}
    if "preprocess" in options:
        # O pré-processamento feito como a configuração pediu; `preprocess_fallback` simula a queda.
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
        "ingest_transcript", recording_id, transcript_key, embeddings_key, info, _queue_name=DEFAULT_QUEUE
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
    """Drena `eclume:gpu` com o `transcribe` fake; devolve as chamadas recebidas.

    `behavior` ajusta o fake: `fail_stage` e `failure` (código, mensagem) na falha, e
    `preprocess_fallback` para a cadeia do pré-processamento caída para só o formato.
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
    """A finalidade da chamada: `fields`, `agenda_detection`, `chat` ou `summaries`.

    Os campos e o resumo compartilham o `system`; as regras dos campos vão no prompt.
    """
    if FIELDS_SYSTEM in prompt:
        return "fields"
    return {DETECT_SYSTEM: "agenda_detection", CHAT_SYSTEM: "chat", BASE_CHAT_SYSTEM: "base_chat"}.get(
        system, "summaries"
    )


@dataclass
class FakeAgents:
    """Fábrica de providers falsos, com respostas por finalidade e erros programados, em ordem.

    `replies[finalidade]` é a fila de respostas daquela finalidade, uma por chamada (o roteiro do
    chat: consultas e a resposta); vazia, vale o padrão: Markdown determinístico no resumo, `{}`
    (nada encontrado) nos campos, o primeiro tipo (`T1`) na detecção e um `reply` sem mudar o
    resumo no chat.
    Os `errors` valem para qualquer
    chamada, antes das respostas; `failures[finalidade]` só para as daquela finalidade.
    """

    errors: list[ProviderError] = field(default_factory=list)
    replies: dict[str, list[str]] = field(default_factory=dict)
    failures: dict[str, list[ProviderError]] = field(default_factory=dict)
    calls: list[tuple[ProviderConfig, str, str]] = field(default_factory=list)

    def of(self, purpose: str) -> list[tuple[ProviderConfig, str, str]]:
        """As chamadas de uma finalidade."""
        return [call for call in self.calls if purpose_of(call[1], call[2]) == purpose]

    def __call__(self, config: ProviderConfig) -> _FakeAgent:
        """O provider falso de `config`."""
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
        elif purpose == "base_chat":
            text = '{"action": "reply", "message": "Pronto.", "sources": []}'
        elif purpose == "chat":
            text = '{"action": "reply", "message": "Pronto.", "summary_md": null}'
        else:
            text = f"# Resumo\n\n- gerado por {self.config.name}"
        return Completion(text=text, model=f"{self.config.model}-fake")


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


def transcribed(
    api: Api,
    settings: Settings,
    *,
    voices: dict[str, list[float]] | None = None,
    **fields: Any,  # noqa: ANN401
) -> dict[str, Any]:
    """Sobe um áudio e roda os dois workers: devolve a gravação já com a transcrição de 3 locutores."""
    recording = upload_file(api, audio_bytes(1000), **fields)
    run_gpu(settings, voices=voices)
    run_cpu(settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["status"] == "transcribed", body
    return body
