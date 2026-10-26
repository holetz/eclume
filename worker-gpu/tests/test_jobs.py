"""The `transcribe` job with fake Redis, S3 and engine."""

from __future__ import annotations

import asyncio
import io
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator, FormatChecker

from eclume_engines import EngineError, EngineOptions, EngineResult, Segment, Word, logs
from eclume_worker import jobs
from eclume_worker.config import WorkerConfig
from eclume_worker.jobs import EngineRegistry, parse_revision, transcribe
from eclume_worker.preprocess import PreprocessError, PreprocessResult

SCHEMA = json.loads((Path(__file__).parents[2] / "contracts" / "transcript.schema.json").read_text())
RECORDING = "01928f3a-1c00-7a00-8000-000000000401"


@dataclass
class FakePreprocess:
    """`preprocess` without ffmpeg: return the file itself (or one per channel) and record the request."""

    offset_ms: int = 0
    duration_ms: int | None = None
    split: bool = False
    error: Exception | None = None
    calls: list[tuple[dict[str, Any] | None, str | None]] = field(default_factory=list)

    def __call__(self, src: Path, workdir: Path, config: dict[str, Any] | None, model: str | None) -> PreprocessResult:
        self.calls.append((config, model))
        if self.error is not None:
            raise self.error
        paths = [src]
        if self.split:
            copy = workdir / "channel-1.wav"
            copy.write_bytes(src.read_bytes())
            paths.append(copy)
        return PreprocessResult(
            paths=paths,
            offset_ms=self.offset_ms,
            channels=2 if self.split else 1,
            split=self.split,
            fallback=False,
            steps=[{"step": "resample", "state": "done"}],
            ffmpeg_version="6.1",
            duration_ms=self.duration_ms,
        )


@pytest.fixture(autouse=True)
def pre(monkeypatch: pytest.MonkeyPatch) -> FakePreprocess:
    fake = FakePreprocess()
    monkeypatch.setattr(jobs, "preprocess", fake)
    return fake


class FakeRedis:
    def __init__(self) -> None:
        self.hashes: dict[str, dict] = {}
        self.history: list[tuple[str, int]] = []
        self.jobs: list[tuple[str, tuple, dict]] = []
        self.keys: set[str] = set()

    async def exists(self, key: str) -> int:
        return int(key in self.keys)

    async def delete(self, key: str) -> None:
        self.hashes.pop(key, None)
        self.keys.discard(key)

    async def hset(self, key: str, mapping: dict) -> None:
        self.hashes.setdefault(key, {}).update(mapping)
        self.history.append((mapping["stage"], mapping["pct"]))

    async def expire(self, key: str, seconds: int) -> None:
        pass

    async def enqueue_job(self, name: str, *args: Any, **kwargs: Any) -> None:
        self.jobs.append((name, args, kwargs))


class FakeStore:
    def __init__(self, *, fail_download: bool = False, fail_upload: bool = False) -> None:
        self.fail_download = fail_download
        self.fail_upload = fail_upload
        self.saved: dict[str, dict] = {}

    def download(self, key: str, dest: Path) -> None:
        if self.fail_download:
            msg = "NoSuchKey"
            raise RuntimeError(msg)
        dest.write_bytes(b"OggS-audio")

    def put_json(self, key: str, document: dict) -> None:
        if self.fail_upload:
            msg = "AccessDenied"
            raise RuntimeError(msg)
        self.saved[key] = document


class FakeEngine:
    def __init__(self, name: str, *, error: Exception | None = None, **kwargs: Any) -> None:
        self.name = name
        self.kwargs = kwargs
        self.error = error
        self.hf_token: str | None = None
        self.calls: list[tuple[Path, EngineOptions, str | None]] = []
        self.unloads = 0

    def transcribe(self, audio_path: Path, options: EngineOptions, progress: Any) -> EngineResult:
        self.calls.append((audio_path, options, self.hf_token))
        assert audio_path.read_bytes() == b"OggS-audio"
        if self.error is not None:
            raise self.error
        for stage in ("asr", "align", "diarize", "embed"):
            progress(stage, 50)
            progress(stage, 100)
        return EngineResult(
            engine=self.name,
            model="large-v3-turbo",
            compute_type="int8_float16",
            # With no requested language, the engine returns the detected one.
            language=options.language or "en",
            duration_s=10.0,
            segments=[
                Segment(0.0, 2.0, "Olá.", "SPEAKER_00", [Word("Olá.", 0.0, 1.0, 0.9)], 0.9),
                Segment(2.0, 4.0, "Oi.", "SPEAKER_01", [], 0.8),
            ],
            speaker_embeddings={"SPEAKER_00": [1.0, 0.0], "SPEAKER_01": [0.0, 1.0]},
            diarization_model="pyannote/speaker-diarization-community-1",
            embedding_model="pyannote/wespeaker-voxceleb-resnet34-LM",
            batch_size=16,
            peak_vram_mb=2500,
            warnings=["example"],
        )

    def unload(self) -> None:
        self.unloads += 1


class Factory:
    def __init__(self, **engine_kwargs: Any) -> None:
        self.engine_kwargs = engine_kwargs
        self.created: list[FakeEngine] = []

    def __call__(self, name: str, **kwargs: Any) -> FakeEngine:
        engine = FakeEngine(name, **self.engine_kwargs, **kwargs)
        self.created.append(engine)
        return engine


def make_ctx(tmp_path: Path, *, store: FakeStore | None = None, factory: Factory | None = None, **cfg: Any) -> dict:
    config = WorkerConfig(work_dir=tmp_path / "work", **cfg)
    return {
        "redis": FakeRedis(),
        "config": config,
        "store": store or FakeStore(),
        "engines": EngineRegistry(config, factory=factory or Factory(), hf_token=lambda: "hf_x"),
        "job_id": f"transcribe:{RECORDING}:3",
    }


def run_job(ctx: dict, options: dict | None = None) -> dict:
    return asyncio.run(transcribe(ctx, RECORDING, f"orgs/o/users/u/{RECORDING}.ogg", options))


def test_success_writes_artifacts_and_enqueues_ingest(tmp_path: Path):
    factory = Factory()
    ctx = make_ctx(tmp_path, factory=factory)
    out = run_job(ctx, {"language": "pt-BR", "min_speakers": 2, "diarize": True, "embeddings": True})

    t_key = f"recordings/{RECORDING}/r3/transcript.raw.json"
    e_key = f"recordings/{RECORDING}/r3/speaker_embeddings.json"
    assert out["status"] == "done"
    transcript = ctx["store"].saved[t_key]
    Draft202012Validator(SCHEMA, format_checker=FormatChecker()).validate(transcript)
    assert transcript["language"] == "pt-BR"
    assert transcript["revision"] == 3
    assert transcript["content_hash"].startswith("sha256:")
    assert ctx["store"].saved[e_key]["speaker_embeddings"] == {"S1": [1.0, 0.0], "S2": [0.0, 1.0]}

    [engine] = factory.created
    [(_, options, token)] = engine.calls
    assert options.language == "pt"
    assert options.min_speakers == 2
    assert token == "hf_x"
    assert engine.name == "whisperx-local"
    assert engine.kwargs == {
        "device": "cuda",
        "batch_size": None,
        "keep_asr_resident": True,
        "resident_min_free_mb": 2500,
    }

    [(name, args, kwargs)] = ctx["redis"].jobs
    assert name == "ingest_transcript"
    assert kwargs == {"_job_id": f"ingest_transcript:{RECORDING}:3", "_queue_name": "eclume:default"}
    assert args[:3] == (RECORDING, t_key, e_key)
    info = args[3]
    assert info["engine"] == "whisperx-local"
    assert info["model"] == "large-v3-turbo"
    assert info["compute_type"] == "int8_float16"
    assert info["duration_ms"] == 10000
    assert info["peak_vram_mb"] == 2500
    assert info["warnings"] == ["example"]
    assert info["realtime_factor"] is not None
    assert info["started_at"] == ctx["redis"].hashes[f"eclume:progress:{RECORDING}"]["started_at"]
    assert info["started_at"].endswith("Z")

    history = ctx["redis"].history
    assert history[-1] == ("upload", 100)
    pcts = [p for _, p in history]
    assert pcts == sorted(pcts)
    stages = [s for s, _ in history]
    assert stages.index("download") < stages.index("asr") < stages.index("diarize") < stages.index("upload")
    assert not any((tmp_path / "work").iterdir())


def test_download_failure(tmp_path: Path):
    ctx = make_ctx(tmp_path, store=FakeStore(fail_download=True))
    out = run_job(ctx)
    assert out["error_code"] == "audio_download_failed"
    [(name, args, kwargs)] = ctx["redis"].jobs
    assert name == "transcription_failed"
    assert args[:2] == (RECORDING, "audio_download_failed")
    assert "NoSuchKey" in args[2]
    assert kwargs == {"_job_id": f"transcription_failed:{RECORDING}:3", "_queue_name": "eclume:default"}
    assert ctx["store"].saved == {}


@pytest.mark.parametrize("failure", [None, "download", "engine"])
def test_return_jobs_carry_the_revision(tmp_path: Path, failure: str | None):
    store = FakeStore(fail_download=failure == "download")
    factory = Factory(error=EngineError("out_of_memory", "VRAM") if failure == "engine" else None)
    ctx = make_ctx(tmp_path, store=store, factory=factory) | {"job_id": f"transcribe:{RECORDING}:7"}
    run_job(ctx)
    [(name, args, kwargs)] = ctx["redis"].jobs
    expected = "ingest_transcript" if failure is None else "transcription_failed"
    assert name == expected
    assert kwargs["_job_id"] == f"{expected}:{RECORDING}:7"
    assert len(args) == 4  # the contract's positionals do not change
    assert ctx["redis"].hashes[f"eclume:progress:{RECORDING}"]["revision"] == 7
    if failure is None:
        assert args[1:3] == (
            f"recordings/{RECORDING}/r7/transcript.raw.json",
            f"recordings/{RECORDING}/r7/speaker_embeddings.json",
        )
        assert set(ctx["store"].saved) == set(args[1:3])


class SpyStore(FakeStore):
    """Record, at each step of the job, what the heartbeat would publish."""

    def __init__(self, registry: list[EngineRegistry], seen: list[tuple[str, bool, str | None]], **kw: Any) -> None:
        super().__init__(**kw)
        self.registry = registry
        self.seen = seen

    def download(self, key: str, dest: Path) -> None:
        self.seen.append(("download", self.registry[0].busy, self.registry[0].current_job))
        super().download(key, dest)


@pytest.mark.parametrize("outcome", ["success", "download", "preprocess", "engine", "unexpected"])
def test_busy_from_the_start_to_the_end_of_the_job(
    tmp_path: Path, pre: FakePreprocess, monkeypatch: pytest.MonkeyPatch, outcome: str
):
    seen: list[tuple[str, bool, str | None]] = []
    holder: list[EngineRegistry] = []
    store = SpyStore(holder, seen, fail_download=outcome == "download")
    error = {"engine": EngineError("out_of_memory", "VRAM"), "unexpected": KeyError("x")}.get(outcome)
    ctx = make_ctx(tmp_path, store=store, factory=Factory(error=error))
    registry: EngineRegistry = ctx["engines"]
    holder.append(registry)
    if outcome == "preprocess":
        pre.error = PreprocessError("does not open")

    def spy_pre(*args: Any) -> PreprocessResult:
        seen.append(("preprocess", registry.busy, registry.current_job))
        return pre(*args)

    monkeypatch.setattr(jobs, "preprocess", spy_pre)
    redis = ctx["redis"]
    enqueue = redis.enqueue_job

    async def spy_enqueue(name: str, *args: Any, **kwargs: Any) -> None:
        seen.append((name, registry.busy, registry.current_job))
        await enqueue(name, *args, **kwargs)

    redis.enqueue_job = spy_enqueue
    run_job(ctx)

    job_id = f"transcribe:{RECORDING}:3"
    return_name = "ingest_transcript" if outcome == "success" else "transcription_failed"
    assert seen[0] == ("download", True, job_id)
    assert seen[-1] == (return_name, True, job_id)
    assert all(busy and current == job_id for _, busy, current in seen)
    if outcome != "download":
        assert ("preprocess", True, job_id) in seen
    assert (registry.busy, registry.current_job) == (False, None)


CANCEL = f"eclume:cancel:{RECORDING}:3"


def test_cancelled_before_starting_does_not_even_download(tmp_path: Path):
    store = SpyStore([], [])
    ctx = make_ctx(tmp_path, store=store)
    holder: list[EngineRegistry] = [ctx["engines"]]
    store.registry = holder
    ctx["redis"].keys.add(CANCEL)
    assert run_job(ctx) == {"status": "cancelled"}
    assert store.seen == []
    assert ctx["redis"].jobs == []
    assert ctx["engines"].busy is False


class SlowEngine(FakeEngine):
    """Long ASR: request cancellation on the first batch and keep calling the callback per batch."""

    def __init__(self, name: str, redis: FakeRedis, **kwargs: Any) -> None:
        super().__init__(name, **kwargs)
        self.redis = redis
        self.batches = 0

    def transcribe(self, audio_path: Path, options: EngineOptions, progress: Any) -> EngineResult:
        self.redis.keys.add(CANCEL)
        for batch in range(500):
            self.batches += 1
            progress("asr", batch / 5)
            time.sleep(0.01)
        return super().transcribe(audio_path, options, progress)


def test_cancelled_mid_asr_stops_with_no_return(tmp_path: Path):
    ctx = make_ctx(tmp_path) | {"cancel_poll_s": 0.01}
    engines: list[SlowEngine] = []

    def factory(name: str, **kwargs: Any) -> SlowEngine:
        engines.append(SlowEngine(name, ctx["redis"], **kwargs))
        return engines[0]

    ctx["engines"] = EngineRegistry(ctx["config"], factory=factory, hf_token=lambda: None)
    assert run_job(ctx) == {"status": "cancelled"}
    # It stopped on an ASR batch, far from the end, with no return to the server, no hash and no working directory.
    assert engines[0].batches < 500
    assert ctx["redis"].jobs == []
    assert f"eclume:progress:{RECORDING}" not in ctx["redis"].hashes
    assert ctx["store"].saved == {}
    assert not any((tmp_path / "work").iterdir())
    assert (ctx["engines"].busy, ctx["engines"].current_job) == (False, None)


def test_engine_failure_carries_the_code(tmp_path: Path):
    ctx = make_ctx(tmp_path, factory=Factory(error=EngineError("out_of_memory", "VRAM insuficiente")))
    run_job(ctx)
    [(name, args, _)] = ctx["redis"].jobs
    assert (name, args) == ("transcription_failed", (RECORDING, "out_of_memory", "VRAM insuficiente", "asr"))


def test_unexpected_error_becomes_internal_error(tmp_path: Path):
    ctx = make_ctx(tmp_path, factory=Factory(error=KeyError("x")))
    out = run_job(ctx)
    assert out["error_code"] == "internal_error"
    assert ctx["redis"].jobs[0][0] == "transcription_failed"


def test_upload_failure(tmp_path: Path):
    ctx = make_ctx(tmp_path, store=FakeStore(fail_upload=True))
    assert run_job(ctx)["error_code"] == "upload_failed"


def test_engine_forced_by_the_environment_wins_over_options(tmp_path: Path):
    factory = Factory()
    ctx = make_ctx(tmp_path, factory=factory, engine="cpu")
    run_job(
        ctx, {"engine": "whisperx-local", "model": "large-v3-turbo", "compute_type": "int8_float16", "batch_size": 4}
    )
    assert factory.created[0].name == "cpu"
    assert factory.created[0].kwargs == {}
    # The admin's model configuration belongs to whisperx-local: the forced engine uses its own defaults.
    [(_, options, _token)] = factory.created[0].calls
    assert (options.model, options.compute_type, options.batch_size) == (None, None, None)


def test_options_pick_the_engine_without_an_environment(tmp_path: Path):
    factory = Factory()
    ctx = make_ctx(tmp_path, factory=factory, remote_base_url="http://speaches:8000", remote_model="m")
    run_job(ctx, {"engine": "openai-compatible"})
    assert factory.created[0].kwargs == {"base_url": "http://speaches:8000", "api_key": None, "default_model": "m"}


def test_remote_without_a_url_fails(tmp_path: Path):
    ctx = make_ctx(tmp_path)
    assert run_job(ctx, {"engine": "openai-compatible"})["error_code"] == "internal_error"


def test_unknown_engine_fails(tmp_path: Path):
    config = WorkerConfig(work_dir=tmp_path / "work")
    ctx = make_ctx(tmp_path)
    ctx["engines"] = EngineRegistry(config, hf_token=lambda: None)
    out = run_job(ctx, {"engine": "does-not-exist"})
    assert out["error_code"] == "internal_error"
    assert "unknown" in out["message"]


def test_idle_unload(tmp_path: Path):
    now = [0.0]
    factory = Factory()
    registry = EngineRegistry(WorkerConfig(), factory=factory, hf_token=lambda: None, clock=lambda: now[0])
    assert registry.unload_if_idle(300) is False  # nada carregado
    audio = tmp_path / "a.ogg"
    audio.write_bytes(b"OggS-audio")
    registry.run("cpu", audio, EngineOptions(), lambda _s, _p: None)
    now[0] = 100.0
    assert registry.unload_if_idle(300) is False
    now[0] = 400.0
    assert registry.unload_if_idle(300) is True
    assert factory.created[0].unloads == 1


def test_idle_unload_only_once_per_use(tmp_path: Path):
    # The idle loop comes back every 30 s: once unloaded, the engine is not unloaded (nor logged) again.
    now = [0.0]
    factory = Factory()
    registry = EngineRegistry(WorkerConfig(), factory=factory, hf_token=lambda: None, clock=lambda: now[0])
    audio = tmp_path / "a.ogg"
    audio.write_bytes(b"OggS-audio")
    registry.run("cpu", audio, EngineOptions(), lambda _s, _p: None)
    now[0] = 400.0
    assert registry.unload_if_idle(300) is True
    for step in (430.0, 460.0, 10_000.0):
        now[0] = step
        assert registry.unload_if_idle(300) is False
    assert factory.created[0].unloads == 1
    # A new use rearms the unload.
    registry.run("cpu", audio, EngineOptions(), lambda _s, _p: None)
    now[0] = 10_400.0
    assert registry.unload_if_idle(300) is True
    assert factory.created[0].unloads == 2


def test_switching_engine_unloads_the_previous_one(tmp_path: Path):
    factory = Factory()
    registry = EngineRegistry(WorkerConfig(), factory=factory, hf_token=lambda: None)
    audio = tmp_path / "a.ogg"
    audio.write_bytes(b"OggS-audio")
    registry.run("cpu", audio, EngineOptions(), lambda _s, _p: None)
    registry.run("whisperx-local", audio, EngineOptions(), lambda _s, _p: None)
    assert factory.created[0].unloads == 1
    assert len(factory.created) == 2


@pytest.mark.parametrize(
    ("job_id", "revision"),
    [(f"transcribe:{RECORDING}:3", 3), (f"transcribe:{RECORDING}:x", 1), (None, 1), ("abc", 1), ("t:r:0", 1)],
)
def test_revision_from_the_job_id(job_id: str | None, revision: int):
    assert parse_revision(job_id) == revision


def _encrypted(text: str, secret_key: str) -> str:
    """The token as the server writes it (same format as eclume_server.crypto)."""
    import base64  # noqa: PLC0415
    import os  # noqa: PLC0415

    from cryptography.hazmat.primitives import hashes  # noqa: PLC0415
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: PLC0415

    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"eclume-secrets-v1").derive(secret_key.encode())
    nonce = os.urandom(12)
    return "v1:" + base64.b64encode(nonce + AESGCM(key).encrypt(nonce, text.encode(), None)).decode()


def test_organization_token_wins_over_the_environment_one(tmp_path: Path):
    factory = Factory()
    ctx = make_ctx(tmp_path, factory=factory, secret_key="server-secret")
    run_job(ctx, {"hf_token_encrypted": _encrypted("hf_of_the_organization", "server-secret")})
    [(_, _, token)] = factory.created[0].calls
    assert token == "hf_of_the_organization"
    info = ctx["redis"].jobs[0][1][3]
    assert "hf_token_undecryptable" not in info["warnings"]

    # The next job, without the secret, goes back to the environment token.
    run_job(ctx, {})
    assert factory.created[0].calls[-1][2] == "hf_x"


@pytest.mark.parametrize("cfg", [{"secret_key": "other-key"}, {}])
def test_token_that_does_not_open_falls_back_to_the_environment_one_with_a_warning(tmp_path: Path, cfg: dict[str, str]):
    factory = Factory()
    ctx = make_ctx(tmp_path, factory=factory, **cfg)
    out = run_job(ctx, {"hf_token_encrypted": _encrypted("hf_of_the_organization", "server-secret")})
    assert out["status"] == "done"
    [(_, _, token)] = factory.created[0].calls
    assert token == "hf_x"
    assert ctx["redis"].jobs[0][1][3]["warnings"] == ["hf_token_undecryptable", "example"]


def test_options_endpoint_wins_over_the_environment_one(tmp_path: Path):
    factory = Factory()
    ctx = make_ctx(tmp_path, factory=factory, remote_base_url="http://speaches:8000")
    run_job(ctx, {"engine": "openai-compatible", "endpoint_url": "http://other:9000/v1"})
    run_job(ctx, {"engine": "openai-compatible", "endpoint_url": "http://other:9000/v1"})
    assert [e.kwargs["base_url"] for e in factory.created] == ["http://other:9000/v1"]
    run_job(ctx, {"engine": "openai-compatible"})
    assert [e.kwargs["base_url"] for e in factory.created] == ["http://other:9000/v1", "http://speaches:8000"]


def test_admin_options_reach_the_engine(tmp_path: Path):
    factory = Factory()
    ctx = make_ctx(tmp_path, factory=factory)
    run_job(ctx, {"batch_size": 2, "fallback_model": "small", "diarization_model": "pyannote/x"})
    [(_, options, _)] = factory.created[0].calls
    assert (options.batch_size, options.fallback_model, options.diarization_model) == (2, "small", "pyannote/x")


def test_automatic_language_reaches_the_engine_as_null_and_comes_out_detected(tmp_path: Path):
    factory = Factory()
    ctx = make_ctx(tmp_path, factory=factory)
    run_job(ctx, {"language": None, "diarize": False, "embeddings": False})
    [engine] = factory.created
    [(_, options, _)] = engine.calls
    assert options.language is None
    transcript = ctx["store"].saved[f"recordings/{RECORDING}/r3/transcript.raw.json"]
    assert transcript["language"] == "en"


def test_preprocesses_before_the_asr_and_gives_back_the_offset(tmp_path: Path, pre: FakePreprocess):
    pre.offset_ms = 2000
    # The original is 15 s: 2 s trimmed from the start, 10 s processed and 3 s trimmed from the end.
    pre.duration_ms = 15_000
    ctx = make_ctx(tmp_path, rnnoise_model="/opt/cb.rnnn")
    options = {"preprocess": {"denoise": {"enabled": True, "method": "rnnoise", "strength": 0.6}}}
    run_job(ctx, options)
    assert pre.calls == [(options["preprocess"], "/opt/cb.rnnn")]
    transcript = ctx["store"].saved[f"recordings/{RECORDING}/r3/transcript.raw.json"]
    # The times go back to the original audio: speech at 0 s in the processed audio is at 2 s in the original.
    assert [(s["start_ms"], s["end_ms"]) for s in transcript["segments"]] == [(2000, 4000), (4000, 6000)]
    assert transcript["segments"][0]["words"][0]["start_ms"] == 2000
    assert transcript["duration_ms"] == 15_000
    [(_, args, _)] = ctx["redis"].jobs
    info = args[3]
    assert info["preprocess"]["offset_ms"] == 2000
    assert info["preprocess"]["ffmpeg_version"] == "6.1"
    stages = [stage for stage, _ in ctx["redis"].history]
    assert stages.index("preprocess") < stages.index("asr")


def test_separated_channels_run_the_asr_per_channel(tmp_path: Path, pre: FakePreprocess):
    pre.split = True
    factory = Factory()
    ctx = make_ctx(tmp_path, factory=factory)
    run_job(ctx, {"diarize": True, "embeddings": True, "min_speakers": 2})
    [engine] = factory.created
    assert [(opts.min_speakers, opts.max_speakers) for _, opts, _ in engine.calls] == [(1, 1), (1, 1)]
    transcript = ctx["store"].saved[f"recordings/{RECORDING}/r3/transcript.raw.json"]
    # One speaker per channel, speech merged by start.
    assert [s["speaker_id"] for s in transcript["segments"]] == ["S1", "S2", "S1", "S2"]
    embeddings = ctx["store"].saved[f"recordings/{RECORDING}/r3/speaker_embeddings.json"]
    assert sorted(embeddings["speaker_embeddings"]) == ["S1", "S2"]


def test_audio_that_does_not_open_fails_in_preprocessing(tmp_path: Path, pre: FakePreprocess):
    pre.error = PreprocessError("the audio does not open")
    ctx = make_ctx(tmp_path)
    assert run_job(ctx)["error_code"] == "audio_decode_failed"
    [(name, args, _)] = ctx["redis"].jobs
    assert (name, args[1], args[3]) == ("transcription_failed", "audio_decode_failed", "preprocess")


def test_job_log_carries_job_id_recording_and_revision(tmp_path: Path):
    stream = io.StringIO()
    logs.configure_logs(stream=stream)
    ctx = make_ctx(tmp_path, store=SpyStore([], []))
    ctx["redis"].keys.add(CANCEL)
    assert run_job(ctx) == {"status": "cancelled"}
    lines = [json.loads(line) for line in stream.getvalue().splitlines()]
    cancelled_line = next(line for line in lines if "cancelled" in line["msg"])
    assert cancelled_line["recording_id"] == RECORDING
    assert cancelled_line["revision"] == 3
    assert cancelled_line["job_id"] == f"transcribe:{RECORDING}:3"
