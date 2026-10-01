"""Job `transcribe` da fila `eclume:gpu` (contrato em docs/standards/api/jobs-transcricao.md).

Baixa o áudio, pré-processa (`preprocess.py`), roda a engine numa thread (uma vez por canal, com
os canais separados), grava `transcript.raw.json` e `speaker_embeddings.json` da revisão no bucket e
enfileira `ingest_transcript` em `eclume:default`. Em falha, enfileira `transcription_failed` com a
etapa em que parou e retorna sem relançar: o retry é decisão do server, não do arq. Os dois retornos
levam a revisão no `_job_id` (`{job}:{recording_id}:{revision}`); os argumentos são os de sempre.

Cancelar é cooperativo: o server grava `eclume:cancel:{recording_id}:{revision}`; o job confere a
chave ao começar e a cada `CANCEL_POLL_S` enquanto roda, e para no próximo ponto de checagem — a
callback de progresso da engine (por lote do ASR e da diarização) e entre download,
pré-processamento, ASR e upload. Cancelado, não enfileira retorno e apaga o hash de progresso e o
diretório de trabalho antes de liberar a vaga.
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
from eclume_engines.registro import contexto_do_job
from eclume_worker import __version__
from eclume_worker.config import DEFAULT_QUEUE
from eclume_worker.preprocess import PreprocessError, PreprocessResult, preprocess
from eclume_worker.progress import ProgressReporter, overall_pct, progress_key
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
# De quanto em quanto tempo o job em curso confere o pedido de cancelamento.
CANCEL_POLL_S = 5.0


class JobCancelledError(Exception):
    """O dono cancelou o job (chave `eclume:cancel:…`): para sem retorno."""


def cancel_key(recording_id: str, revision: int) -> str:
    """Chave em que o server pede a parada do `transcribe` da revisão."""
    return f"eclume:cancel:{recording_id}:{revision}"


def _checkpoint(stop: threading.Event) -> None:
    if stop.is_set():
        raise JobCancelledError


async def _watch_cancel(redis: Any, key: str, stop: threading.Event, every: float) -> None:  # noqa: ANN401 — ArqRedis
    """Liga `stop` quando a chave de cancelamento aparece; uma falha do Redis só vai ao log."""
    while not stop.is_set():
        try:
            if await redis.exists(key):
                stop.set()
                return
        except Exception:
            logger.exception("conferência do cancelamento falhou")
        await asyncio.sleep(every)


class JobFailedError(Exception):
    """Falha com `error_code` do contrato, reportada por `transcription_failed`."""

    def __init__(self, code: str, message: str) -> None:
        """Guarda o código do contrato junto da mensagem."""
        super().__init__(message)
        self.code = code
        self.message = message


def return_job_id(job: str, recording_id: str, revision: int) -> str:
    """`_job_id` `{job}:{recording_id}:{revision}`: o do `transcribe` e o dos retornos da revisão."""
    return f"{job}:{recording_id}:{revision}"


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
        # O `_job_id` do `transcribe` em execução (do download ao enfileiramento do retorno).
        self.current_job: str | None = None
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
        """Há um `transcribe` em execução (ou a engine em uso)."""
        return self.current_job is not None or self._lock.locked()

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
            # o da plataforma (vindo no job) vence; o do ambiente é relido a cada job
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
    reporter: ProgressReporter, loop: asyncio.AbstractEventLoop, stop: threading.Event
) -> tuple[Callable[[str, float], None], list[Any]]:
    """Callback para a thread da engine: agenda no loop só quando o `pct` geral muda.

    Com o cancelamento pedido, levanta `JobCancelledError` na thread da engine, no próximo lote.
    """
    futures: list[Any] = []
    last: list[tuple[str, int]] = []

    def progress(stage: str, stage_pct: float) -> None:
        _checkpoint(stop)
        mark = (stage, overall_pct(stage, stage_pct))
        if last and last[-1] == mark:
            return
        last.append(mark)
        futures.append(asyncio.run_coroutine_threadsafe(reporter.report(stage, stage_pct), loop))

    return progress, futures


async def transcribe(ctx: dict[str, Any], recording_id: str, audio_key: str, options: dict[str, Any] | None) -> dict:
    """Job `transcribe(recording_id, audio_key, options)` do contrato."""
    config: WorkerConfig = ctx["config"]
    registry: EngineRegistry = ctx["engines"]
    redis = ctx["redis"]
    revision = parse_revision(ctx.get("job_id"))
    registry.current_job = ctx.get("job_id") or return_job_id("transcribe", recording_id, revision)
    contexto_do_job(registry.current_job, recording_id, revision)
    try:
        cancel = cancel_key(recording_id, revision)
        if await redis.exists(cancel):
            logger.info("gravação %s (revisão %s): cancelada antes de começar", recording_id, revision)
            return {"status": "cancelled"}
        stop = threading.Event()
        watcher = asyncio.create_task(_watch_cancel(redis, cancel, stop, ctx.get("cancel_poll_s", CANCEL_POLL_S)))
        config.work_dir.mkdir(parents=True, exist_ok=True)
        workdir = Path(tempfile.mkdtemp(prefix=f"{recording_id}-", dir=config.work_dir))
        reporter = ProgressReporter(redis, recording_id, revision)
        try:
            return await _run(ctx, recording_id, audio_key, dict(options or {}), workdir, reporter=reporter, stop=stop)
        except Exception as exc:
            # Cancelado, a engine pode ter embrulhado a interrupção num erro dela: vale o pedido.
            if stop.is_set() or isinstance(exc, JobCancelledError):
                return await _cancelled(redis, reporter)
            if isinstance(exc, JobFailedError):
                return await _fail(redis, reporter, exc)
            logger.exception("gravação %s: erro inesperado", recording_id)
            return await _fail(redis, reporter, JobFailedError(INTERNAL_ERROR, f"{type(exc).__name__}: {exc}"))
        finally:
            watcher.cancel()
            shutil.rmtree(workdir, ignore_errors=True)
    finally:
        registry.current_job = None


async def _cancelled(redis: Any, reporter: ProgressReporter) -> dict:  # noqa: ANN401 — ArqRedis
    """Sem retorno ao server (o job já está `cancelled` no banco); o hash de progresso sai."""
    logger.info("gravação %s (revisão %s): cancelada em %s", reporter.recording_id, reporter.revision, reporter.stage)
    await redis.delete(progress_key(reporter.recording_id))
    return {"status": "cancelled"}


async def _run(  # noqa: PLR0913 — o job, o reporter de progresso que a falha também lê e o cancelamento
    ctx: dict[str, Any],
    recording_id: str,
    audio_key: str,
    options: dict[str, Any],
    workdir: Path,
    *,
    reporter: ProgressReporter,
    stop: threading.Event,
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
    _checkpoint(stop)

    pre = await _preprocess(ctx["config"], reporter, audio_path, workdir, options.get("preprocess"))
    _checkpoint(stop)

    hf_token, token_warnings = _platform_hf_token(ctx["config"], options.get("hf_token_encrypted"))
    progress, futures = _thread_progress(reporter, asyncio.get_running_loop(), stop)
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
    # O alinhamento não chama a callback: o pedido feito durante ele vale aqui.
    _checkpoint(stop)
    processing_s = time.monotonic() - engine_started
    result.warnings[:0] = [*token_warnings, *pre.warnings]
    for warning in result.warnings:
        logger.warning("gravação %s: %s", recording_id, warning)

    transcript = build_transcript(
        result,
        recording_id=recording_id,
        revision=reporter.revision,
        content_hash=content_hash,
        # O pedido (com a região), ou o que a engine detectou.
        language=options.get("language") or result.language,
        now=datetime.now(UTC),
        offset_ms=pre.offset_ms,
        duration_ms=pre.duration_ms,
    )
    await reporter.report("upload")
    t_key = transcript_key(recording_id, reporter.revision)
    e_key = embeddings_key(recording_id, reporter.revision)
    try:
        await asyncio.to_thread(store.put_json, t_key, transcript)
        await asyncio.to_thread(store.put_json, e_key, build_embeddings(result))
    except Exception as exc:
        raise JobFailedError(UPLOAD_FAILED, f"falha ao gravar os artefatos: {exc}") from exc

    info = _engine_info(result, processing_s, time.monotonic() - started, reporter.started_at, pre)
    _checkpoint(stop)
    # 100 antes do retorno: o server apaga o hash ao ingerir, e uma gravação depois o recriaria.
    await reporter.report("upload", 100)
    await redis.enqueue_job(
        "ingest_transcript",
        recording_id,
        t_key,
        e_key,
        info,
        _job_id=return_job_id("ingest_transcript", recording_id, reporter.revision),
        _queue_name=DEFAULT_QUEUE,
    )
    logger.info("gravação %s transcrita: %s", recording_id, info)
    return {"status": "done", "transcript_key": t_key, "embeddings_key": e_key, "engine_info": info}


def _platform_hf_token(config: WorkerConfig, encrypted: str | None) -> tuple[str | None, list[str]]:
    """Token do HF da plataforma (cifrado nas `options`); não abrir cai no do ambiente, com aviso."""
    if not encrypted:
        return None, []
    try:
        return open_secret(encrypted, encryption_key=config.encryption_key, secret_key=config.secret_key), []
    except SecretError as exc:
        logger.warning("token do HF da plataforma não abre (%s); usando o do ambiente", exc)
        return None, [WARN_HF_TOKEN_UNDECRYPTABLE]


async def _fail(redis: Any, reporter: ProgressReporter, failure: JobFailedError) -> dict:  # noqa: ANN401 — ArqRedis
    recording_id, revision, stage = reporter.recording_id, reporter.revision, reporter.stage
    code, message = failure.code, failure.message
    logger.error("gravação %s (revisão %s) falhou em %s (%s): %s", recording_id, revision, stage, code, message)
    await redis.enqueue_job(
        "transcription_failed",
        recording_id,
        code,
        message,
        stage,
        _job_id=return_job_id("transcription_failed", recording_id, revision),
        _queue_name=DEFAULT_QUEUE,
    )
    return {"status": "failed", "error_code": code, "message": message}
