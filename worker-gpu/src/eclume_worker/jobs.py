"""Job `transcribe` da fila `eclume:gpu` (contrato em docs/standards/api/jobs-transcricao.md).

Baixa o áudio, pré-processa (`preprocess.py`), roda a engine numa thread (uma vez por canal, com
os canais separados), grava `transcript.raw.json` e `speaker_embeddings.json` no bucket e enfileira
`ingest_transcript` em `eclume:default`. Em falha, enfileira `transcription_failed` com a etapa em
que parou e retorna sem relançar: o retry é decisão do server, não do arq.
"""

from __future__ import annotations

import asyncio
import dataclasses
import functools
import logging
import shutil
import tempfile
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from eclume_engines import DEFAULT_ENGINE, EngineError, EngineOptions, get_engine
from eclume_engines.hf_token import resolve_hf_token
from eclume_worker import __version__
from eclume_worker.config import DEFAULT_QUEUE
from eclume_worker.preprocess import PreprocessError, PreprocessResult, preprocess
from eclume_worker.progress import ProgressReporter, overall_pct
from eclume_worker.secrets import SecretError, open_secret
from eclume_worker.storage import ArtifactStore, embeddings_key, sha256_file, transcript_key
from eclume_worker.transcript import build_embeddings, build_transcript

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_engines import Engine, EngineResult
    from eclume_worker.config import WorkerConfig

logger = logging.getLogger(__name__)

AUDIO_DOWNLOAD_FAILED = "audio_download_failed"
UPLOAD_FAILED = "upload_failed"
INTERNAL_ERROR = "internal_error"
WARN_HF_TOKEN_UNDECRYPTABLE = "hf_token_undecryptable"  # noqa: S105 — código de aviso, não segredo


class JobFailedError(Exception):
    """Falha com `error_code` do contrato, reportada por `transcription_failed`."""

    def __init__(self, code: str, message: str) -> None:
        """Guarda o código do contrato junto da mensagem."""
        super().__init__(message)
        self.code = code
        self.message = message


def parse_revision(job_id: str | None) -> int:
    """Lê a revisão do `_job_id` `transcribe:{recording_id}:{revision}`; padrão 1."""
    try:
        return max(1, int(str(job_id).rsplit(":", 1)[1]))
    except (IndexError, ValueError):
        return 1


class EngineRegistry:
    """Mantém a engine do processo, marca uso e descarrega os modelos ociosos."""

    def __init__(
        self,
        config: WorkerConfig,
        factory: Callable[..., Engine] = get_engine,
        hf_token: Callable[[], str | None] = resolve_hf_token,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """A engine é criada na primeira vez que um job a pede."""
        self.config = config
        self.factory = factory
        self.hf_token = hf_token
        self.clock = clock
        self._lock = threading.Lock()
        self._key: tuple[str, str | None] | None = None
        self._engine: Engine | None = None
        self._last_used = clock()
        # A engine continua no registro depois da descarga ociosa (recarrega no próximo job); isto
        # diz se os modelos dela já foram descarregados desde o último uso.
        self._unloaded = False

    def resolve_name(self, options: dict[str, Any]) -> str:
        """`ECLUME_ENGINE` força a engine do processo; senão vale `options.engine`."""
        return self.config.engine or options.get("engine") or DEFAULT_ENGINE

    @property
    def current_name(self) -> str | None:
        """Engine criada no processo, se alguma."""
        return self._key[0] if self._key else None

    @property
    def busy(self) -> bool:
        """Há um job usando a engine agora."""
        return self._lock.locked()

    def loaded_models(self) -> list[dict[str, Any]]:
        """Modelos residentes da engine, para o heartbeat; engines sem o método não declaram nenhum."""
        loaded = getattr(self._engine, "loaded_models", None)
        return loaded() if loaded is not None else []

    def _kwargs(self, name: str, base_url: str | None) -> dict[str, Any]:
        if name == "whisperx-local":
            return {
                "device": self.config.device,
                "batch_size": self.config.batch_size,
                "keep_asr_resident": self.config.keep_asr_resident,
                "resident_min_free_mb": self.config.resident_min_free_mb,
            }
        if name == "openai-compatible":
            if not base_url:
                msg = "engine openai-compatible sem endpoint_url nas options nem ECLUME_REMOTE_BASE_URL"
                raise JobFailedError(INTERNAL_ERROR, msg)
            kwargs: dict[str, Any] = {"base_url": base_url, "api_key": self.config.remote_api_key}
            if self.config.remote_model:
                kwargs["default_model"] = self.config.remote_model
            return kwargs
        return {}

    def _get(self, name: str, base_url: str | None, hf_token: str | None) -> Engine:
        base_url = (base_url or self.config.remote_base_url) if name == "openai-compatible" else None
        if self._key != (name, base_url) or self._engine is None:
            if self._engine is not None:
                self._engine.unload()
            try:
                self._engine = self.factory(name, **self._kwargs(name, base_url))
            except ValueError as exc:
                raise JobFailedError(INTERNAL_ERROR, str(exc)) from exc
            self._key = (name, base_url)
        if hasattr(self._engine, "hf_token"):
            # o da organização (vindo no job) vence; o do ambiente é relido a cada job
            self._engine.hf_token = hf_token or self.hf_token()
        return self._engine

    def run(  # noqa: PLR0913 — o job passa o que a engine precisa, nomeado
        self,
        name: str,
        audio_path: Path,
        options: EngineOptions,
        progress: Callable[[str, float], None],
        *,
        base_url: str | None = None,
        hf_token: str | None = None,
    ) -> EngineResult:
        """Transcreve segurando o lock, para a descarga ociosa não disputar a engine."""
        with self._lock:
            try:
                return self._get(name, base_url, hf_token).transcribe(audio_path, options, progress)
            finally:
                self._last_used = self.clock()
                self._unloaded = False

    def unload_if_idle(self, idle_seconds: float) -> bool:
        """Descarrega se nenhum job usou a engine há `idle_seconds`; não bloqueia um job em curso.

        Devolve `True` só na descarga de fato: já descarregada desde o último uso, não há o que
        descarregar de novo (nem o que logar a cada volta do laço ocioso).
        """
        if not self._lock.acquire(blocking=False):
            return False
        try:
            if self._engine is None or self._unloaded or self.clock() - self._last_used < idle_seconds:
                return False
            self._engine.unload()
            self._unloaded = True
            return True
        finally:
            self._lock.release()

    def unload(self) -> None:
        """Descarrega incondicionalmente (desligamento do worker)."""
        with self._lock:
            if self._engine is not None:
                self._engine.unload()


def _engine_info(
    result: EngineResult, processing_s: float, job_s: float, started_at: str, pre: PreprocessResult
) -> dict[str, Any]:
    return {
        "preprocess": pre.info(),
        "started_at": started_at,
        "engine": result.engine,
        "model": result.model,
        "compute_type": result.compute_type,
        "batch_size": result.batch_size,
        "language": result.language,
        "duration_ms": round(result.duration_s * 1000),
        "processing_ms": round(processing_s * 1000),
        "job_ms": round(job_s * 1000),
        "realtime_factor": round(processing_s / result.duration_s, 4) if result.duration_s else None,
        "peak_vram_mb": result.peak_vram_mb,
        "align_model": result.align_model,
        "diarization_model": result.diarization_model,
        "embedding_model": result.embedding_model,
        "warnings": list(result.warnings),
        "worker_version": __version__,
    }


async def _preprocess(
    config: WorkerConfig, reporter: ProgressReporter, audio_path: Path, workdir: Path, settings: dict[str, Any] | None
) -> PreprocessResult:
    """O pré-processamento numa thread, com a etapa `preprocess` no progresso."""
    await reporter.report("preprocess")
    try:
        pre = await asyncio.to_thread(preprocess, audio_path, workdir, settings, config.rnnoise_model)
    except PreprocessError as exc:
        raise JobFailedError(exc.code, exc.message) from exc
    await reporter.report("preprocess", 100)
    await reporter.report("asr")
    return pre


def _asr(run: Callable[..., EngineResult], paths: list[Path], options: EngineOptions) -> EngineResult:
    """O ASR do áudio tratado; com os canais separados, uma vez por canal, e a mescla.

    Cada canal é uma pessoa (`min_speakers = max_speakers = 1`, o que mantém o embedding para a
    identificação por voz): as falas do canal k ganham o rótulo `CANAL_k` e os segmentos se mesclam
    pelo início.
    """
    if len(paths) == 1:
        return run(paths[0], options)
    one = dataclasses.replace(options, min_speakers=1, max_speakers=1)
    results = [run(path, one) for path in paths]
    merged = results[0]
    segments, embeddings = [], {}
    for channel, result in enumerate(results):
        label = f"CANAL_{channel}"
        for segment in result.segments:
            segment.speaker = label
            for word in segment.words:
                word.speaker = label
            segments.append(segment)
        if result.speaker_embeddings:
            embeddings[label] = next(iter(result.speaker_embeddings.values()))
    return dataclasses.replace(
        merged,
        segments=sorted(segments, key=lambda s: s.start),
        speaker_embeddings=embeddings,
        duration_s=max(r.duration_s for r in results),
        warnings=list(dict.fromkeys(w for r in results for w in r.warnings)),
        peak_vram_mb=max((r.peak_vram_mb for r in results if r.peak_vram_mb is not None), default=None),
    )


def _thread_progress(
    reporter: ProgressReporter, loop: asyncio.AbstractEventLoop
) -> tuple[Callable[[str, float], None], list[Any]]:
    """Callback para a thread da engine: agenda no loop só quando o `pct` geral muda."""
    futures: list[Any] = []
    last: list[tuple[str, int]] = []

    def progress(stage: str, stage_pct: float) -> None:
        mark = (stage, overall_pct(stage, stage_pct))
        if last and last[-1] == mark:
            return
        last.append(mark)
        futures.append(asyncio.run_coroutine_threadsafe(reporter.report(stage, stage_pct), loop))

    return progress, futures


async def transcribe(ctx: dict[str, Any], recording_id: str, audio_key: str, options: dict[str, Any] | None) -> dict:
    """Job `transcribe(recording_id, audio_key, options)` do contrato."""
    config: WorkerConfig = ctx["config"]
    config.work_dir.mkdir(parents=True, exist_ok=True)
    workdir = Path(tempfile.mkdtemp(prefix=f"{recording_id}-", dir=config.work_dir))
    reporter = ProgressReporter(ctx["redis"], recording_id)
    try:
        return await _run(ctx, recording_id, audio_key, dict(options or {}), workdir, reporter=reporter)
    except JobFailedError as exc:
        return await _fail(ctx["redis"], recording_id, exc.code, exc.message, reporter.stage)
    except Exception as exc:
        logger.exception("gravação %s: erro inesperado", recording_id)
        return await _fail(ctx["redis"], recording_id, INTERNAL_ERROR, f"{type(exc).__name__}: {exc}", reporter.stage)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


async def _run(  # noqa: PLR0913 — o job e o reporter de progresso que a falha também lê
    ctx: dict[str, Any],
    recording_id: str,
    audio_key: str,
    options: dict[str, Any],
    workdir: Path,
    *,
    reporter: ProgressReporter,
) -> dict:
    started = time.monotonic()
    redis = ctx["redis"]
    store: ArtifactStore = ctx["store"]
    registry: EngineRegistry = ctx["engines"]
    engine_options = EngineOptions.from_mapping(options)
    if engine_options.language:
        engine_options = dataclasses.replace(engine_options, language=engine_options.language.split("-", 1)[0].lower())
    engine_name = registry.resolve_name(options)
    if options.get("engine") and engine_name != options["engine"]:
        # Modelo, compute type e lote do admin são da engine que ele escolheu; a engine forçada pelo
        # operador (`ECLUME_ENGINE`, ex. `cpu` no dev e no E2E) usa os padrões dela.
        engine_options = dataclasses.replace(
            engine_options, model=None, compute_type=None, batch_size=None, fallback_model=None
        )
    await reporter.report("download")
    audio_path = workdir / (Path(audio_key).name or "audio")
    try:
        await asyncio.to_thread(store.download, audio_key, audio_path)
        content_hash = await asyncio.to_thread(sha256_file, audio_path)
    except Exception as exc:
        raise JobFailedError(AUDIO_DOWNLOAD_FAILED, f"falha ao baixar {audio_key}: {exc}") from exc
    await reporter.report("download", 100)

    pre = await _preprocess(ctx["config"], reporter, audio_path, workdir, options.get("preprocess"))

    hf_token, token_warnings = _organization_hf_token(ctx["config"], options.get("hf_token_encrypted"))
    progress, futures = _thread_progress(reporter, asyncio.get_running_loop())
    engine_started = time.monotonic()
    run = functools.partial(
        registry.run, engine_name, progress=progress, base_url=options.get("endpoint_url"), hf_token=hf_token
    )
    try:
        result = await asyncio.to_thread(_asr, run, pre.paths, engine_options)
    except EngineError as exc:
        raise JobFailedError(exc.code, exc.message) from exc
    finally:
        await asyncio.gather(*(asyncio.wrap_future(f) for f in futures), return_exceptions=True)
    processing_s = time.monotonic() - engine_started
    result.warnings[:0] = [*token_warnings, *pre.warnings]
    for warning in result.warnings:
        logger.warning("gravação %s: %s", recording_id, warning)

    transcript = build_transcript(
        result,
        recording_id=recording_id,
        revision=parse_revision(ctx.get("job_id")),
        content_hash=content_hash,
        # O pedido (com a região), ou o que a engine detectou.
        language=options.get("language") or result.language,
        now=datetime.now(UTC),
        offset_ms=pre.offset_ms,
        duration_ms=pre.duration_ms,
    )
    await reporter.report("upload")
    t_key, e_key = transcript_key(recording_id), embeddings_key(recording_id)
    try:
        await asyncio.to_thread(store.put_json, t_key, transcript)
        await asyncio.to_thread(store.put_json, e_key, build_embeddings(result))
    except Exception as exc:
        raise JobFailedError(UPLOAD_FAILED, f"falha ao gravar os artefatos: {exc}") from exc

    info = _engine_info(result, processing_s, time.monotonic() - started, reporter.started_at, pre)
    # 100 antes do retorno: o server apaga o hash ao ingerir, e uma gravação depois o recriaria.
    await reporter.report("upload", 100)
    await redis.enqueue_job("ingest_transcript", recording_id, t_key, e_key, info, _queue_name=DEFAULT_QUEUE)
    logger.info("gravação %s transcrita: %s", recording_id, info)
    return {"status": "done", "transcript_key": t_key, "embeddings_key": e_key, "engine_info": info}


def _organization_hf_token(config: WorkerConfig, encrypted: str | None) -> tuple[str | None, list[str]]:
    """Token do HF da organização (cifrado nas `options`); não abrir cai no do ambiente, com aviso."""
    if not encrypted:
        return None, []
    try:
        return open_secret(encrypted, encryption_key=config.encryption_key, secret_key=config.secret_key), []
    except SecretError as exc:
        logger.warning("token do HF da organização não abre (%s); usando o do ambiente", exc)
        return None, [WARN_HF_TOKEN_UNDECRYPTABLE]


async def _fail(redis: Any, recording_id: str, code: str, message: str, stage: str | None) -> dict:  # noqa: ANN401 — ArqRedis
    logger.error("gravação %s falhou em %s (%s): %s", recording_id, stage, code, message)
    await redis.enqueue_job("transcription_failed", recording_id, code, message, stage, _queue_name=DEFAULT_QUEUE)
    return {"status": "failed", "error_code": code, "message": message}
