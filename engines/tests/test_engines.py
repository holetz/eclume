import sys

import pytest

import eclume_engines
from eclume_engines import EngineOptions, UnknownEngineError, get_engine
from eclume_engines.base import EngineError, is_oom


def test_pacote_importa_com_versao():
    assert eclume_engines.__version__ == "0.1.0"


def test_importar_o_pacote_nao_carrega_dependencia_pesada():
    for pesado in ("torch", "whisperx", "faster_whisper", "ctranslate2"):
        assert pesado not in sys.modules


def test_opcoes_a_partir_do_dict_do_job():
    opts = EngineOptions.from_mapping(
        {
            "language": "pt",
            "engine": "whisperx-local",
            "model": "large-v3-turbo",
            "compute_type": None,
            "min_speakers": "2",
            "max_speakers": 4,
            "diarize": False,
            "embeddings": False,
            "batch_size": 2,
            "fallback_model": "medium",
            "diarization_model": None,
            "hf_token_encrypted": "v1:ignorado-pela-engine",
        }
    )
    assert opts == EngineOptions(
        language="pt",
        model="large-v3-turbo",
        compute_type=None,
        diarize=False,
        embeddings=False,
        min_speakers=2,
        max_speakers=4,
        batch_size=2,
        fallback_model="medium",
    )


def test_opcoes_vazias_usam_os_padroes():
    assert EngineOptions.from_mapping(None) == EngineOptions()
    assert EngineOptions.from_mapping({}).language == "pt"
    # `language: null` é o idioma automático: a engine detecta.
    assert EngineOptions.from_mapping({"language": None}).language is None


def test_fabrica_recusa_engine_desconhecida():
    with pytest.raises(UnknownEngineError, match="desconhecida"):
        get_engine("nao-existe")


def test_engine_error_carrega_o_codigo():
    err = EngineError("asr_failed", "falhou")
    assert err.code == "asr_failed"
    assert str(err) == "falhou"


@pytest.mark.parametrize(
    ("mensagem", "esperado"),
    [
        ("CUDA out of memory. Tried to allocate 20.00 MiB", True),
        ("CUDA failed with error out of memory", True),
        ("RuntimeError: shape mismatch", False),
    ],
)
def test_reconhece_oom(mensagem: str, *, esperado: bool):
    assert is_oom(RuntimeError(mensagem)) is esperado


def test_retrato_da_gpu_pela_nvml():
    from types import SimpleNamespace  # noqa: PLC0415

    from eclume_engines.vram import VramMonitor  # noqa: PLC0415

    mib = 1024 * 1024
    nvml = SimpleNamespace(
        nvmlDeviceGetMemoryInfo=lambda _h: SimpleNamespace(total=6144 * mib, used=3120 * mib, free=3024 * mib),
        nvmlDeviceGetName=lambda _h: b"NVIDIA GeForce GTX 1660 SUPER",
        nvmlDeviceGetUtilizationRates=lambda _h: SimpleNamespace(gpu=87),
    )
    monitor = VramMonitor()
    monitor._nvml, monitor._handle = nvml, object()
    assert monitor.snapshot() == {
        "gpu_name": "NVIDIA GeForce GTX 1660 SUPER",
        "vram_total_mb": 6144,
        "vram_used_mb": 3120,
        "utilization_pct": 87.0,
    }
    monitor._nvml = None
    assert monitor.snapshot() is None
