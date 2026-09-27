"""Pré-processamento com o ffmpeg de verdade, sobre áudios sintéticos (`lavfi`).

Sem ffmpeg no PATH (a estação Windows), o módulo pula; no host e na imagem, roda.
"""

from __future__ import annotations

import shutil
import subprocess
import wave
from typing import TYPE_CHECKING, Any

import pytest

from eclume_worker.preprocess import (
    AUDIO_DECODE_FAILED,
    PREPROCESS_FAILED,
    WARN_RNNOISE_MODEL_MISSING,
    PreprocessError,
    preprocess,
)

if TYPE_CHECKING:
    from pathlib import Path

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="sem ffmpeg no PATH")

CONFIG: dict[str, Any] = {
    "denoise": {"enabled": True, "method": "afftdn", "strength": 0.6},
    "loudnorm": {"enabled": True, "target_lufs": -16, "true_peak_db": -1.5, "lra": 11},
    "trim_silence": {"enabled": True, "min_silence_s": 1, "threshold_db": -50},
    "split_channels": {"enabled": True},
}
# 2 s de silêncio, 3 s de fala sintética (tom com ruído) e 2 s de silêncio.
SPEECH = (
    "anullsrc=r=44100:cl=mono:d=2[a];sine=f=300:r=44100:d=3,volume=0.5[b];"
    "anullsrc=r=44100:cl=mono:d=2[c];[a][b][c]concat=n=3:v=0:a=1"
)


def _make(path: Path, graph: str) -> Path:
    subprocess.run(  # noqa: S603
        ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-filter_complex", graph, "-c:a", "libopus", str(path)],  # noqa: S607
        check=True,
        capture_output=True,
    )
    return path


def _wav(path: Path) -> tuple[int, int, float]:
    with wave.open(str(path)) as audio:
        return audio.getnchannels(), audio.getframerate(), audio.getnframes() / audio.getframerate()


def _steps(result: Any) -> dict[str, dict[str, Any]]:
    return {step["step"]: step for step in result.steps}


def test_corta_o_silencio_e_converte_para_16k_mono(tmp_path: Path):
    src = _make(tmp_path / "fala.ogg", SPEECH)
    result = preprocess(src, tmp_path, CONFIG, None)
    (path,) = result.paths
    channels, rate, duration = _wav(path)
    assert (channels, rate) == (1, 16_000)
    assert duration == pytest.approx(3.0, abs=0.3)
    assert result.offset_ms == pytest.approx(2000, abs=150)
    steps = _steps(result)
    assert steps["trim_silence"]["state"] == "done"
    assert (steps["loudnorm"]["state"], steps["denoise"]["params"]["method"]) == ("done", "afftdn")
    assert steps["split_channels"]["reason"] == "not_stereo"
    assert result.fallback is False
    assert result.ffmpeg_version
    assert result.info()["offset_ms"] == result.offset_ms


def test_sem_modelo_do_rnnoise_usa_afftdn_com_aviso(tmp_path: Path):
    src = _make(tmp_path / "fala.ogg", SPEECH)
    config = {**CONFIG, "denoise": {"enabled": True, "method": "rnnoise", "strength": 0.5}}
    result = preprocess(src, tmp_path, config, str(tmp_path / "nao-existe.rnnn"))
    assert _steps(result)["denoise"]["params"]["method"] == "afftdn"
    assert result.warnings == [WARN_RNNOISE_MODEL_MISSING]


def test_falha_da_cadeia_cai_para_so_o_formato(tmp_path: Path):
    src = _make(tmp_path / "fala.ogg", SPEECH)
    broken = tmp_path / "quebrado.rnnn"
    broken.write_text("isto não é um modelo")
    config = {**CONFIG, "denoise": {"enabled": True, "method": "rnnoise", "strength": 0.5}}
    result = preprocess(src, tmp_path, config, str(broken))
    assert result.fallback is True
    assert PREPROCESS_FAILED in result.warnings
    steps = _steps(result)
    assert steps["denoise"]["state"] == "failed"
    assert steps["denoise"]["error"]
    assert _wav(result.paths[0])[:2] == (1, 16_000)


def test_estereo_de_duas_fontes_separa_os_canais(tmp_path: Path):
    graph = (
        "anullsrc=r=44100:cl=mono:d=1,asplit[s1][s2];sine=f=300:r=44100:d=2[v1];sine=f=900:r=44100:d=2[v2];"
        "[s1][v1]concat=n=2:v=0:a=1[l];[s2][v2]concat=n=2:v=0:a=1[r];[l][r]join=inputs=2:channel_layout=stereo"
    )
    src = _make(tmp_path / "estereo.ogg", graph)
    result = preprocess(src, tmp_path, CONFIG, None)
    assert (result.split, result.channels, len(result.paths)) == (True, 2, 2)
    assert all(_wav(path)[:2] == (1, 16_000) for path in result.paths)
    # O mesmo corte vale para os dois canais.
    assert len({round(_wav(path)[2], 2) for path in result.paths}) == 1


def test_mono_duplicado_nao_separa(tmp_path: Path):
    src = _make(tmp_path / "duplicado.ogg", SPEECH + ",pan=stereo|c0=c0|c1=c0")
    result = preprocess(src, tmp_path, CONFIG, None)
    assert (result.split, _steps(result)["split_channels"]["reason"]) == (False, "dual_mono")


def test_tudo_desligado_so_converte(tmp_path: Path):
    src = _make(tmp_path / "fala.ogg", SPEECH)
    result = preprocess(src, tmp_path, None, None)
    steps = _steps(result)
    assert {name: step["state"] for name, step in steps.items()} == {
        "resample": "done",
        "split_channels": "skipped",
        "denoise": "skipped",
        "loudnorm": "skipped",
        "trim_silence": "skipped",
    }
    assert result.offset_ms == 0
    assert _wav(result.paths[0])[2] == pytest.approx(7.0, abs=0.2)


def test_audio_que_nao_abre(tmp_path: Path):
    src = tmp_path / "lixo.ogg"
    src.write_bytes(b"nao e audio" * 100)
    with pytest.raises(PreprocessError) as info:
        preprocess(src, tmp_path, CONFIG, None)
    assert info.value.code == AUDIO_DECODE_FAILED
