import re
import sys

import pytest

import eclume_engines
from eclume_engines import EngineOptions, UnknownEngineError, get_engine
from eclume_engines.base import EngineError, is_oom


def test_package_imports_with_version():
    assert re.fullmatch(r"\d+\.\d+\.\d+", eclume_engines.__version__)


def test_importing_the_package_loads_no_heavy_dependency():
    for heavy in ("torch", "whisperx", "faster_whisper", "ctranslate2"):
        assert heavy not in sys.modules


def test_options_from_the_job_dict():
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
            "hf_token_encrypted": "v1:ignored-by-the-engine",
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


def test_empty_options_use_the_defaults():
    assert EngineOptions.from_mapping(None) == EngineOptions()
    assert EngineOptions.from_mapping({}).language == "pt"
    # `language: null` is automatic language: the engine detects it.
    assert EngineOptions.from_mapping({"language": None}).language is None


def test_factory_refuses_an_unknown_engine():
    with pytest.raises(UnknownEngineError, match="desconhecida"):
        get_engine("does-not-exist")


def test_engine_error_carries_the_code():
    err = EngineError("asr_failed", "failed")
    assert err.code == "asr_failed"
    assert str(err) == "failed"


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ("CUDA out of memory. Tried to allocate 20.00 MiB", True),
        ("CUDA failed with error out of memory", True),
        ("RuntimeError: shape mismatch", False),
    ],
)
def test_recognizes_oom(message: str, *, expected: bool):
    assert is_oom(RuntimeError(message)) is expected


def test_gpu_snapshot_through_nvml():
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
