"""Job `transcribe` com Redis, S3 e engine fakes."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator, FormatChecker

from eclume_engines import EngineError, EngineOptions, EngineResult, Segment, Word
from eclume_worker.config import WorkerConfig
from eclume_worker.jobs import EngineRegistry, parse_revision, transcribe

SCHEMA = json.loads((Path(__file__).parents[2] / "contracts" / "transcript.schema.json").read_text())
RECORDING = "01928f3a-1c00-7a00-8000-000000000401"


class FakeRedis:
    def __init__(self) -> None:
        self.hashes: dict[str, dict] = {}
        self.history: list[tuple[str, int]] = []
        self.jobs: list[tuple[str, tuple, dict]] = []

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
            language=options.language,
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
            warnings=["exemplo"],
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


def contexto(tmp_path: Path, *, store: FakeStore | None = None, factory: Factory | None = None, **cfg: Any) -> dict:
    config = WorkerConfig(work_dir=tmp_path / "work", **cfg)
    return {
        "redis": FakeRedis(),
        "config": config,
        "store": store or FakeStore(),
        "engines": EngineRegistry(config, factory=factory or Factory(), hf_token=lambda: "hf_x"),
        "job_id": f"transcribe:{RECORDING}:3",
    }


def rodar(ctx: dict, options: dict | None = None) -> dict:
    return asyncio.run(transcribe(ctx, RECORDING, f"orgs/o/users/u/{RECORDING}.ogg", options))


def test_sucesso_grava_artefatos_e_enfileira_ingest(tmp_path: Path):
    factory = Factory()
    ctx = contexto(tmp_path, factory=factory)
    out = rodar(ctx, {"language": "pt-BR", "min_speakers": 2, "diarize": True, "embeddings": True})

    t_key = f"recordings/{RECORDING}/transcript.raw.json"
    e_key = f"recordings/{RECORDING}/speaker_embeddings.json"
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
    assert engine.kwargs == {"device": "cuda"}

    [(name, args, kwargs)] = ctx["redis"].jobs
    assert name == "ingest_transcript"
    assert kwargs == {"_queue_name": "eclume:default"}
    assert args[:3] == (RECORDING, t_key, e_key)
    info = args[3]
    assert info["engine"] == "whisperx-local"
    assert info["model"] == "large-v3-turbo"
    assert info["compute_type"] == "int8_float16"
    assert info["duration_ms"] == 10000
    assert info["peak_vram_mb"] == 2500
    assert info["warnings"] == ["exemplo"]
    assert info["realtime_factor"] is not None

    history = ctx["redis"].history
    assert history[-1] == ("upload", 100)
    pcts = [p for _, p in history]
    assert pcts == sorted(pcts)
    stages = [s for s, _ in history]
    assert stages.index("download") < stages.index("asr") < stages.index("diarize") < stages.index("upload")
    assert not any((tmp_path / "work").iterdir())


def test_falha_no_download(tmp_path: Path):
    ctx = contexto(tmp_path, store=FakeStore(fail_download=True))
    out = rodar(ctx)
    assert out["error_code"] == "audio_download_failed"
    [(name, args, kwargs)] = ctx["redis"].jobs
    assert name == "transcription_failed"
    assert args[:2] == (RECORDING, "audio_download_failed")
    assert "NoSuchKey" in args[2]
    assert kwargs == {"_queue_name": "eclume:default"}
    assert ctx["store"].saved == {}


def test_falha_da_engine_leva_o_codigo(tmp_path: Path):
    ctx = contexto(tmp_path, factory=Factory(error=EngineError("out_of_memory", "VRAM insuficiente")))
    rodar(ctx)
    [(name, args, _)] = ctx["redis"].jobs
    assert (name, args) == ("transcription_failed", (RECORDING, "out_of_memory", "VRAM insuficiente"))


def test_erro_inesperado_vira_internal_error(tmp_path: Path):
    ctx = contexto(tmp_path, factory=Factory(error=KeyError("x")))
    out = rodar(ctx)
    assert out["error_code"] == "internal_error"
    assert ctx["redis"].jobs[0][0] == "transcription_failed"


def test_falha_no_upload(tmp_path: Path):
    ctx = contexto(tmp_path, store=FakeStore(fail_upload=True))
    assert rodar(ctx)["error_code"] == "upload_failed"


def test_engine_forcada_pelo_ambiente_vence_options(tmp_path: Path):
    factory = Factory()
    ctx = contexto(tmp_path, factory=factory, engine="cpu")
    rodar(ctx, {"engine": "whisperx-local"})
    assert factory.created[0].name == "cpu"
    assert factory.created[0].kwargs == {}


def test_options_escolhe_a_engine_sem_ambiente(tmp_path: Path):
    factory = Factory()
    ctx = contexto(tmp_path, factory=factory, remote_base_url="http://speaches:8000", remote_model="m")
    rodar(ctx, {"engine": "openai-compatible"})
    assert factory.created[0].kwargs == {"base_url": "http://speaches:8000", "api_key": None, "default_model": "m"}


def test_remota_sem_url_falha(tmp_path: Path):
    ctx = contexto(tmp_path)
    assert rodar(ctx, {"engine": "openai-compatible"})["error_code"] == "internal_error"


def test_engine_desconhecida_falha(tmp_path: Path):
    config = WorkerConfig(work_dir=tmp_path / "work")
    ctx = contexto(tmp_path)
    ctx["engines"] = EngineRegistry(config, hf_token=lambda: None)
    out = rodar(ctx, {"engine": "nao-existe"})
    assert out["error_code"] == "internal_error"
    assert "desconhecida" in out["message"]


def test_descarga_ociosa(tmp_path: Path):
    agora = [0.0]
    factory = Factory()
    registry = EngineRegistry(WorkerConfig(), factory=factory, hf_token=lambda: None, clock=lambda: agora[0])
    assert registry.unload_if_idle(300) is False  # nada carregado
    audio = tmp_path / "a.ogg"
    audio.write_bytes(b"OggS-audio")
    registry.run("cpu", audio, EngineOptions(), lambda _s, _p: None)
    agora[0] = 100.0
    assert registry.unload_if_idle(300) is False
    agora[0] = 400.0
    assert registry.unload_if_idle(300) is True
    assert factory.created[0].unloads == 1


def test_troca_de_engine_descarrega_a_anterior(tmp_path: Path):
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
def test_revisao_do_job_id(job_id: str | None, revision: int):
    assert parse_revision(job_id) == revision
