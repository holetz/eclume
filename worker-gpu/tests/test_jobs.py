"""Job `transcribe` com Redis, S3 e engine fakes."""

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

from eclume_engines import EngineError, EngineOptions, EngineResult, Segment, Word, registro
from eclume_worker import jobs
from eclume_worker.config import WorkerConfig
from eclume_worker.jobs import EngineRegistry, parse_revision, transcribe
from eclume_worker.preprocess import PreprocessError, PreprocessResult

SCHEMA = json.loads((Path(__file__).parents[2] / "contracts" / "transcript.schema.json").read_text())
RECORDING = "01928f3a-1c00-7a00-8000-000000000401"


@dataclass
class FakePreprocess:
    """O `preprocess` sem ffmpeg: devolve o próprio arquivo (ou um por canal) e registra o pedido."""

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
            copy = workdir / "canal-1.wav"
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
            # Sem idioma pedido, a engine devolve o detectado.
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
    assert info["warnings"] == ["exemplo"]
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


def test_falha_no_download(tmp_path: Path):
    ctx = contexto(tmp_path, store=FakeStore(fail_download=True))
    out = rodar(ctx)
    assert out["error_code"] == "audio_download_failed"
    [(name, args, kwargs)] = ctx["redis"].jobs
    assert name == "transcription_failed"
    assert args[:2] == (RECORDING, "audio_download_failed")
    assert "NoSuchKey" in args[2]
    assert kwargs == {"_job_id": f"transcription_failed:{RECORDING}:3", "_queue_name": "eclume:default"}
    assert ctx["store"].saved == {}


@pytest.mark.parametrize("falha", [None, "download", "engine"])
def test_jobs_de_retorno_levam_a_revisao(tmp_path: Path, falha: str | None):
    store = FakeStore(fail_download=falha == "download")
    factory = Factory(error=EngineError("out_of_memory", "VRAM") if falha == "engine" else None)
    ctx = contexto(tmp_path, store=store, factory=factory) | {"job_id": f"transcribe:{RECORDING}:7"}
    rodar(ctx)
    [(name, args, kwargs)] = ctx["redis"].jobs
    esperado = "ingest_transcript" if falha is None else "transcription_failed"
    assert name == esperado
    assert kwargs["_job_id"] == f"{esperado}:{RECORDING}:7"
    assert len(args) == 4  # os posicionais do contrato não mudam
    assert ctx["redis"].hashes[f"eclume:progress:{RECORDING}"]["revision"] == 7
    if falha is None:
        assert args[1:3] == (
            f"recordings/{RECORDING}/r7/transcript.raw.json",
            f"recordings/{RECORDING}/r7/speaker_embeddings.json",
        )
        assert set(ctx["store"].saved) == set(args[1:3])


class SpyStore(FakeStore):
    """Registra, a cada passo do job, o que o heartbeat publicaria."""

    def __init__(self, registry: list[EngineRegistry], seen: list[tuple[str, bool, str | None]], **kw: Any) -> None:
        super().__init__(**kw)
        self.registry = registry
        self.seen = seen

    def download(self, key: str, dest: Path) -> None:
        self.seen.append(("download", self.registry[0].busy, self.registry[0].current_job))
        super().download(key, dest)


@pytest.mark.parametrize("desfecho", ["sucesso", "download", "preprocess", "engine", "inesperado"])
def test_ocupado_do_inicio_ao_fim_do_job(
    tmp_path: Path, pre: FakePreprocess, monkeypatch: pytest.MonkeyPatch, desfecho: str
):
    seen: list[tuple[str, bool, str | None]] = []
    holder: list[EngineRegistry] = []
    store = SpyStore(holder, seen, fail_download=desfecho == "download")
    error = {"engine": EngineError("out_of_memory", "VRAM"), "inesperado": KeyError("x")}.get(desfecho)
    ctx = contexto(tmp_path, store=store, factory=Factory(error=error))
    registry: EngineRegistry = ctx["engines"]
    holder.append(registry)
    if desfecho == "preprocess":
        pre.error = PreprocessError("não abre")

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
    rodar(ctx)

    job_id = f"transcribe:{RECORDING}:3"
    retorno = "ingest_transcript" if desfecho == "sucesso" else "transcription_failed"
    assert seen[0] == ("download", True, job_id)
    assert seen[-1] == (retorno, True, job_id)
    assert all(busy and current == job_id for _, busy, current in seen)
    if desfecho != "download":
        assert ("preprocess", True, job_id) in seen
    assert (registry.busy, registry.current_job) == (False, None)


CANCEL = f"eclume:cancel:{RECORDING}:3"


def test_cancelado_antes_de_comecar_nem_baixa(tmp_path: Path):
    store = SpyStore([], [])
    ctx = contexto(tmp_path, store=store)
    holder: list[EngineRegistry] = [ctx["engines"]]
    store.registry = holder
    ctx["redis"].keys.add(CANCEL)
    assert rodar(ctx) == {"status": "cancelled"}
    assert store.seen == []
    assert ctx["redis"].jobs == []
    assert ctx["engines"].busy is False


class SlowEngine(FakeEngine):
    """ASR longo: pede o cancelamento no primeiro lote e segue chamando a callback por lote."""

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


def test_cancelado_no_meio_do_asr_para_sem_retorno(tmp_path: Path):
    ctx = contexto(tmp_path) | {"cancel_poll_s": 0.01}
    engines: list[SlowEngine] = []

    def factory(name: str, **kwargs: Any) -> SlowEngine:
        engines.append(SlowEngine(name, ctx["redis"], **kwargs))
        return engines[0]

    ctx["engines"] = EngineRegistry(ctx["config"], factory=factory, hf_token=lambda: None)
    assert rodar(ctx) == {"status": "cancelled"}
    # Parou num lote do ASR, longe do fim, sem retorno ao server, sem hash e sem diretório de trabalho.
    assert engines[0].batches < 500
    assert ctx["redis"].jobs == []
    assert f"eclume:progress:{RECORDING}" not in ctx["redis"].hashes
    assert ctx["store"].saved == {}
    assert not any((tmp_path / "work").iterdir())
    assert (ctx["engines"].busy, ctx["engines"].current_job) == (False, None)


def test_falha_da_engine_leva_o_codigo(tmp_path: Path):
    ctx = contexto(tmp_path, factory=Factory(error=EngineError("out_of_memory", "VRAM insuficiente")))
    rodar(ctx)
    [(name, args, _)] = ctx["redis"].jobs
    assert (name, args) == ("transcription_failed", (RECORDING, "out_of_memory", "VRAM insuficiente", "asr"))


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
    rodar(ctx, {"engine": "whisperx-local", "model": "large-v3-turbo", "compute_type": "int8_float16", "batch_size": 4})
    assert factory.created[0].name == "cpu"
    assert factory.created[0].kwargs == {}
    # A configuração de modelo do admin é da whisperx-local: a engine forçada usa os padrões dela.
    [(_, options, _token)] = factory.created[0].calls
    assert (options.model, options.compute_type, options.batch_size) == (None, None, None)


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


def test_descarga_ociosa_so_uma_vez_por_uso(tmp_path: Path):
    # O laço ocioso volta a cada 30 s: já descarregada, a engine não é descarregada (nem logada) de novo.
    agora = [0.0]
    factory = Factory()
    registry = EngineRegistry(WorkerConfig(), factory=factory, hf_token=lambda: None, clock=lambda: agora[0])
    audio = tmp_path / "a.ogg"
    audio.write_bytes(b"OggS-audio")
    registry.run("cpu", audio, EngineOptions(), lambda _s, _p: None)
    agora[0] = 400.0
    assert registry.unload_if_idle(300) is True
    for passo in (430.0, 460.0, 10_000.0):
        agora[0] = passo
        assert registry.unload_if_idle(300) is False
    assert factory.created[0].unloads == 1
    # Um novo uso rearma a descarga.
    registry.run("cpu", audio, EngineOptions(), lambda _s, _p: None)
    agora[0] = 10_400.0
    assert registry.unload_if_idle(300) is True
    assert factory.created[0].unloads == 2


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


def _cifrado(texto: str, secret_key: str) -> str:
    """O token como o server o grava (mesmo formato de eclume_server.crypto)."""
    import base64  # noqa: PLC0415
    import os  # noqa: PLC0415

    from cryptography.hazmat.primitives import hashes  # noqa: PLC0415
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: PLC0415

    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"eclume-secrets-v1").derive(secret_key.encode())
    nonce = os.urandom(12)
    return "v1:" + base64.b64encode(nonce + AESGCM(key).encrypt(nonce, texto.encode(), None)).decode()


def test_token_da_organizacao_vence_o_do_ambiente(tmp_path: Path):
    factory = Factory()
    ctx = contexto(tmp_path, factory=factory, secret_key="segredo-do-server")
    rodar(ctx, {"hf_token_encrypted": _cifrado("hf_da_organizacao", "segredo-do-server")})
    [(_, _, token)] = factory.created[0].calls
    assert token == "hf_da_organizacao"
    info = ctx["redis"].jobs[0][1][3]
    assert "hf_token_undecryptable" not in info["warnings"]

    # O job seguinte, sem o segredo, volta ao token do ambiente.
    rodar(ctx, {})
    assert factory.created[0].calls[-1][2] == "hf_x"


@pytest.mark.parametrize("cfg", [{"secret_key": "outra-chave"}, {}])
def test_token_que_nao_abre_cai_no_do_ambiente_com_aviso(tmp_path: Path, cfg: dict[str, str]):
    factory = Factory()
    ctx = contexto(tmp_path, factory=factory, **cfg)
    out = rodar(ctx, {"hf_token_encrypted": _cifrado("hf_da_organizacao", "segredo-do-server")})
    assert out["status"] == "done"
    [(_, _, token)] = factory.created[0].calls
    assert token == "hf_x"
    assert ctx["redis"].jobs[0][1][3]["warnings"] == ["hf_token_undecryptable", "exemplo"]


def test_endpoint_das_options_vence_o_do_ambiente(tmp_path: Path):
    factory = Factory()
    ctx = contexto(tmp_path, factory=factory, remote_base_url="http://speaches:8000")
    rodar(ctx, {"engine": "openai-compatible", "endpoint_url": "http://outro:9000/v1"})
    rodar(ctx, {"engine": "openai-compatible", "endpoint_url": "http://outro:9000/v1"})
    assert [e.kwargs["base_url"] for e in factory.created] == ["http://outro:9000/v1"]
    rodar(ctx, {"engine": "openai-compatible"})
    assert [e.kwargs["base_url"] for e in factory.created] == ["http://outro:9000/v1", "http://speaches:8000"]


def test_opcoes_do_admin_chegam_a_engine(tmp_path: Path):
    factory = Factory()
    ctx = contexto(tmp_path, factory=factory)
    rodar(ctx, {"batch_size": 2, "fallback_model": "small", "diarization_model": "pyannote/x"})
    [(_, options, _)] = factory.created[0].calls
    assert (options.batch_size, options.fallback_model, options.diarization_model) == (2, "small", "pyannote/x")


def test_idioma_automatico_chega_nulo_a_engine_e_sai_detectado(tmp_path: Path):
    factory = Factory()
    ctx = contexto(tmp_path, factory=factory)
    rodar(ctx, {"language": None, "diarize": False, "embeddings": False})
    [engine] = factory.created
    [(_, options, _)] = engine.calls
    assert options.language is None
    transcript = ctx["store"].saved[f"recordings/{RECORDING}/r3/transcript.raw.json"]
    assert transcript["language"] == "en"


def test_preprocessa_antes_do_asr_e_devolve_o_deslocamento(tmp_path: Path, pre: FakePreprocess):
    pre.offset_ms = 2000
    # O original tem 15 s: 2 s cortados do início, 10 s tratados e 3 s cortados do fim.
    pre.duration_ms = 15_000
    ctx = contexto(tmp_path, rnnoise_model="/opt/cb.rnnn")
    options = {"preprocess": {"denoise": {"enabled": True, "method": "rnnoise", "strength": 0.6}}}
    rodar(ctx, options)
    assert pre.calls == [(options["preprocess"], "/opt/cb.rnnn")]
    transcript = ctx["store"].saved[f"recordings/{RECORDING}/r3/transcript.raw.json"]
    # Os tempos voltam ao áudio original: a fala de 0 s no tratado é 2 s no original.
    assert [(s["start_ms"], s["end_ms"]) for s in transcript["segments"]] == [(2000, 4000), (4000, 6000)]
    assert transcript["segments"][0]["words"][0]["start_ms"] == 2000
    assert transcript["duration_ms"] == 15_000
    [(_, args, _)] = ctx["redis"].jobs
    info = args[3]
    assert info["preprocess"]["offset_ms"] == 2000
    assert info["preprocess"]["ffmpeg_version"] == "6.1"
    stages = [stage for stage, _ in ctx["redis"].history]
    assert stages.index("preprocess") < stages.index("asr")


def test_canais_separados_rodam_o_asr_por_canal(tmp_path: Path, pre: FakePreprocess):
    pre.split = True
    factory = Factory()
    ctx = contexto(tmp_path, factory=factory)
    rodar(ctx, {"diarize": True, "embeddings": True, "min_speakers": 2})
    [engine] = factory.created
    assert [(opts.min_speakers, opts.max_speakers) for _, opts, _ in engine.calls] == [(1, 1), (1, 1)]
    transcript = ctx["store"].saved[f"recordings/{RECORDING}/r3/transcript.raw.json"]
    # Um locutor por canal, falas mescladas pelo início.
    assert [s["speaker_id"] for s in transcript["segments"]] == ["S1", "S2", "S1", "S2"]
    embeddings = ctx["store"].saved[f"recordings/{RECORDING}/r3/speaker_embeddings.json"]
    assert sorted(embeddings["speaker_embeddings"]) == ["S1", "S2"]


def test_audio_que_nao_abre_falha_no_preprocessamento(tmp_path: Path, pre: FakePreprocess):
    pre.error = PreprocessError("o áudio não abre")
    ctx = contexto(tmp_path)
    assert rodar(ctx)["error_code"] == "audio_decode_failed"
    [(name, args, _)] = ctx["redis"].jobs
    assert (name, args[1], args[3]) == ("transcription_failed", "audio_decode_failed", "preprocess")


def test_log_do_job_leva_job_id_gravacao_e_revisao(tmp_path: Path):
    stream = io.StringIO()
    registro.configurar_logs(stream=stream)
    ctx = contexto(tmp_path, store=SpyStore([], []))
    ctx["redis"].keys.add(CANCEL)
    assert rodar(ctx) == {"status": "cancelled"}
    linhas = [json.loads(linha) for linha in stream.getvalue().splitlines()]
    cancelada = next(linha for linha in linhas if "cancelada" in linha["msg"])
    assert cancelada["recording_id"] == RECORDING
    assert cancelada["revision"] == 3
    assert cancelada["job_id"] == f"transcribe:{RECORDING}:3"
