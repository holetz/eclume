"""`transcribe` job of the `eclume:gpu` queue (contract in docs/standards/api/jobs-transcricao.md).

Download the audio, preprocess it (`preprocess.py`), run the engine in a thread (once per channel,
with separated channels), write the revision's `transcript.raw.json` and `speaker_embeddings.json`
to the bucket and enqueue `ingest_transcript` on `eclume:default`. On failure, enqueue
`transcription_failed` with the stage where it stopped and return without re-raising: the retry is
the server's decision, not arq's. Both returns carry the revision in the `_job_id`
(`{job}:{recording_id}:{revision}`); the arguments are the usual ones.

Cancelling is cooperative: the server writes `eclume:cancel:{recording_id}:{revision}`; the job
checks the key at the start and every `CANCEL_POLL_S` while it runs, and stops at the next
checkpoint — the engine's progress callback (per ASR and diarization batch) and between download,
preprocessing, ASR and upload. When cancelled, it enqueues no return and deletes the progress hash
and the working directory before freeing the slot.
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
from eclume_engines.logs import job_context
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
WARN_HF_TOKEN_UNDECRYPTABLE = "hf_token_undecryptable"  # noqa: S105 — warning code, not a secret
# How often the running job checks for the cancellation request.
CANCEL_POLL_S = 5.0


class JobCancelledError(Exception):
    """The owner cancelled the job (`eclume:cancel:…` key): stop with no return."""


def cancel_key(recording_id: str, revision: int) -> str:
    """Key where the server asks for the revision's `transcribe` to stop."""
    return f"eclume:cancel:{recording_id}:{revision}"


def _checkpoint(stop: threading.Event) -> None:
    if stop.is_set():
        raise JobCancelledError


async def _watch_cancel(redis: Any, key: str, stop: threading.Event, every: float) -> None:  # noqa: ANN401 — ArqRedis
    """Set `stop` when the cancellation key appears; a Redis failure only goes to the log."""
    while not stop.is_set():
        try:
            if await redis.exists(key):
                stop.set()
                return
        except Exception:
            logger.exception("cancellation check failed")
        await asyncio.sleep(every)


class JobFailedError(Exception):
    """Failure with the contract's `error_code`, reported by `transcription_failed`."""

    def __init__(self, code: str, message: str) -> None:
        """Keep the contract code together with the message."""
        super().__init__(message)
        self.code = code
        self.message = message


def return_job_id(job: str, recording_id: str, revision: int) -> str:
    """`_job_id` `{job}:{recording_id}:{revision}`: the `transcribe`'s and the revision's returns'."""
    return f"{job}:{recording_id}:{revision}"


def parse_revision(job_id: str | None) -> int:
    """Read the revision from the `_job_id` `transcribe:{recording_id}:{revision}`; default 1."""
    try:
        return max(1, int(str(job_id).rsplit(":", 1)[1]))
    except (IndexError, ValueError):
        return 1


class EngineRegistry:
    """Hold the process's engine, mark usage and unload idle models."""

    def __init__(
        self,
        config: WorkerConfig,
        factory: Callable[..., Engine] = get_engine,
        hf_token: Callable[[], str | None] = resolve_hf_token,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """The engine is created the first time a job asks for it."""
        self.config = config
        self.factory = factory
        self.hf_token = hf_token
        self.clock = clock
        self._lock = threading.Lock()
        self._key: tuple[str, str | None] | None = None
        self._engine: Engine | None = None
        self._last_used = clock()
        # The `_job_id` of the running `transcribe` (from download to enqueueing the return).
        self.current_job: str | None = None
        # The engine stays in the registry after the idle unload (it reloads on the next job); this
        # says whether its models have been unloaded since the last use.
        self._unloaded = False

    def resolve_name(self, options: dict[str, Any]) -> str:
        """`ECLUME_ENGINE` forces the process's engine; otherwise `options.engine` applies."""
        return self.config.engine or options.get("engine") or DEFAULT_ENGINE

    @property
    def current_name(self) -> str | None:
        """Engine created in the process, if any."""
        return self._key[0] if self._key else None

    @property
    def busy(self) -> bool:
        """There is a `transcribe` running (or the engine in use)."""
        return self.current_job is not None or self._lock.locked()

    def loaded_models(self) -> list[dict[str, Any]]:
        """The engine's resident models, for the heartbeat; engines without the method declare none."""
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
            # the platform's (coming in the job) wins; the environment's is re-read on each job
            self._engine.hf_token = hf_token or self.hf_token()
        return self._engine

    def run(  # noqa: PLR0913 — the job passes what the engine needs, named
        self,
        name: str,
        audio_path: Path,
        options: EngineOptions,
        progress: Callable[[str, float], None],
        *,
        base_url: str | None = None,
        hf_token: str | None = None,
    ) -> EngineResult:
        """Transcribe holding the lock, so the idle unload does not compete for the engine."""
        with self._lock:
            try:
                return self._get(name, base_url, hf_token).transcribe(audio_path, options, progress)
            finally:
                self._last_used = self.clock()
                self._unloaded = False

    def unload_if_idle(self, idle_seconds: float) -> bool:
        """Unload if no job has used the engine for `idle_seconds`; it does not block a running job.

        Return `True` only on an actual unload: once unloaded since the last use, there is nothing to
        unload again (nor to log on every round of the idle loop).
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
        """Unload unconditionally (worker shutdown)."""
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
    """Preprocessing in a thread, with the `preprocess` stage in the progress."""
    await reporter.report("preprocess")
    try:
        pre = await asyncio.to_thread(preprocess, audio_path, workdir, settings, config.rnnoise_model)
    except PreprocessError as exc:
        raise JobFailedError(exc.code, exc.message) from exc
    await reporter.report("preprocess", 100)
    await reporter.report("asr")
    return pre


def _asr(run: Callable[..., EngineResult], paths: list[Path], options: EngineOptions) -> EngineResult:
    """The ASR of the processed audio; with separated channels, once per channel, then the merge.

    Each channel is one person (`min_speakers = max_speakers = 1`, which keeps the embedding for
    voice identification): the speech of channel k gets the label `CHANNEL_k` and the segments are
    merged by start.
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
    """Callback for the engine thread: schedule on the loop only when the overall `pct` changes.

    With cancellation requested, raise `JobCancelledError` in the engine thread, on the next batch.
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
    """The contract's `transcribe(recording_id, audio_key, options)` job."""
    config: WorkerConfig = ctx["config"]
    registry: EngineRegistry = ctx["engines"]
    redis = ctx["redis"]
    revision = parse_revision(ctx.get("job_id"))
    registry.current_job = ctx.get("job_id") or return_job_id("transcribe", recording_id, revision)
    job_context(registry.current_job, recording_id, revision)
    try:
        cancel = cancel_key(recording_id, revision)
        if await redis.exists(cancel):
            logger.info("recording %s (revision %s): cancelled before starting", recording_id, revision)
            return {"status": "cancelled"}
        stop = threading.Event()
        watcher = asyncio.create_task(_watch_cancel(redis, cancel, stop, ctx.get("cancel_poll_s", CANCEL_POLL_S)))
        config.work_dir.mkdir(parents=True, exist_ok=True)
        workdir = Path(tempfile.mkdtemp(prefix=f"{recording_id}-", dir=config.work_dir))
        reporter = ProgressReporter(redis, recording_id, revision)
        try:
            return await _run(ctx, recording_id, audio_key, dict(options or {}), workdir, reporter=reporter, stop=stop)
        except Exception as exc:
            # When cancelled, the engine may have wrapped the interruption in an error of its own: the request wins.
            if stop.is_set() or isinstance(exc, JobCancelledError):
                return await _cancelled(redis, reporter)
            if isinstance(exc, JobFailedError):
                return await _fail(redis, reporter, exc)
            logger.exception("recording %s: unexpected error", recording_id)
            return await _fail(redis, reporter, JobFailedError(INTERNAL_ERROR, f"{type(exc).__name__}: {exc}"))
        finally:
            watcher.cancel()
            shutil.rmtree(workdir, ignore_errors=True)
    finally:
        registry.current_job = None


async def _cancelled(redis: Any, reporter: ProgressReporter) -> dict:  # noqa: ANN401 — ArqRedis
    """No return to the server (the job is already `cancelled` in the database); the progress hash goes away."""
    logger.info("recording %s (revision %s): cancelled at %s", reporter.recording_id, reporter.revision, reporter.stage)
    await redis.delete(progress_key(reporter.recording_id))
    return {"status": "cancelled"}


async def _run(  # noqa: PLR0913 — the job, the progress reporter the failure also reads, and the cancellation
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
        # The admin's model, compute type and batch belong to the engine they chose; the engine forced by
        # the operator (`ECLUME_ENGINE`, e.g. `cpu` in dev and E2E) uses its own defaults.
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
    # Alignment does not call the callback: a request made during it counts here.
    _checkpoint(stop)
    processing_s = time.monotonic() - engine_started
    result.warnings[:0] = [*token_warnings, *pre.warnings]
    for warning in result.warnings:
        logger.warning("recording %s: %s", recording_id, warning)

    transcript = build_transcript(
        result,
        recording_id=recording_id,
        revision=reporter.revision,
        content_hash=content_hash,
        # The requested one (with the region), or what the engine detected.
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
    # 100 before the return: the server deletes the hash on ingest, and a later write would recreate it.
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
    logger.info("recording %s transcribed: %s", recording_id, info)
    return {"status": "done", "transcript_key": t_key, "embeddings_key": e_key, "engine_info": info}


def _platform_hf_token(config: WorkerConfig, encrypted: str | None) -> tuple[str | None, list[str]]:
    """The platform's HF token (encrypted in the `options`); failing to open it falls back to the environment's, with a warning."""
    if not encrypted:
        return None, []
    try:
        return open_secret(encrypted, encryption_key=config.encryption_key, secret_key=config.secret_key), []
    except SecretError as exc:
        logger.warning("platform HF token does not open (%s); using the environment's", exc)
        return None, [WARN_HF_TOKEN_UNDECRYPTABLE]


async def _fail(redis: Any, reporter: ProgressReporter, failure: JobFailedError) -> dict:  # noqa: ANN401 — ArqRedis
    recording_id, revision, stage = reporter.recording_id, reporter.revision, reporter.stage
    code, message = failure.code, failure.message
    logger.error("recording %s (revision %s) failed at %s (%s): %s", recording_id, revision, stage, code, message)
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
