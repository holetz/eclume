"""Preprocessing with the real ffmpeg, over synthetic audio (`lavfi`).

Without ffmpeg on PATH (the Windows workstation), these tests skip; on the host and in the image,
they run. Choosing the container from the initial bytes does not need ffmpeg and always runs.
"""

from __future__ import annotations

import shutil
import subprocess
import wave
from typing import TYPE_CHECKING, Any

import pytest

from eclume_worker import preprocess as module
from eclume_worker.preprocess import (
    AUDIO_DECODE_FAILED,
    PREPROCESS_FAILED,
    WARN_RNNOISE_MODEL_MISSING,
    PreprocessError,
    demuxer,
    preprocess,
)

if TYPE_CHECKING:
    from pathlib import Path

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="no ffmpeg on PATH")

CONFIG: dict[str, Any] = {
    "denoise": {"enabled": True, "method": "afftdn", "strength": 0.6},
    "loudnorm": {"enabled": True, "target_lufs": -16, "true_peak_db": -1.5, "lra": 11},
    "trim_silence": {"enabled": True, "min_silence_s": 1, "threshold_db": -50},
    "split_channels": {"enabled": True},
}
# 2 s of silence, 3 s of synthetic speech (a tone with noise) and 2 s of silence.
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


@needs_ffmpeg
def test_trims_the_silence_and_converts_to_16k_mono(tmp_path: Path):
    src = _make(tmp_path / "speech.ogg", SPEECH)
    result = preprocess(src, tmp_path, CONFIG, None)
    (path,) = result.paths
    channels, rate, duration = _wav(path)
    assert (channels, rate) == (1, 16_000)
    assert duration == pytest.approx(3.0, abs=0.3)
    assert result.offset_ms == pytest.approx(2000, abs=150)
    # The duration is the original's, with the silences trimmed.
    assert result.duration_ms == pytest.approx(7000, abs=100)
    steps = _steps(result)
    assert steps["trim_silence"]["state"] == "done"
    assert (steps["loudnorm"]["state"], steps["denoise"]["params"]["method"]) == ("done", "afftdn")
    assert steps["split_channels"]["reason"] == "not_stereo"
    assert result.fallback is False
    assert result.ffmpeg_version
    assert result.info()["offset_ms"] == result.offset_ms


@needs_ffmpeg
def test_without_the_rnnoise_model_uses_afftdn_with_a_warning(tmp_path: Path):
    src = _make(tmp_path / "speech.ogg", SPEECH)
    config = {**CONFIG, "denoise": {"enabled": True, "method": "rnnoise", "strength": 0.5}}
    result = preprocess(src, tmp_path, config, str(tmp_path / "does-not-exist.rnnn"))
    assert _steps(result)["denoise"]["params"]["method"] == "afftdn"
    assert result.warnings == [WARN_RNNOISE_MODEL_MISSING]


@needs_ffmpeg
def test_chain_failure_falls_back_to_format_only(tmp_path: Path):
    src = _make(tmp_path / "speech.ogg", SPEECH)
    broken = tmp_path / "broken.rnnn"
    broken.write_text("this is not a model")
    config = {**CONFIG, "denoise": {"enabled": True, "method": "rnnoise", "strength": 0.5}}
    result = preprocess(src, tmp_path, config, str(broken))
    assert result.fallback is True
    assert PREPROCESS_FAILED in result.warnings
    steps = _steps(result)
    assert steps["denoise"]["state"] == "failed"
    assert steps["denoise"]["error"]
    assert _wav(result.paths[0])[:2] == (1, 16_000)


@needs_ffmpeg
def test_two_source_stereo_splits_the_channels(tmp_path: Path):
    graph = (
        "anullsrc=r=44100:cl=mono:d=1,asplit[s1][s2];sine=f=300:r=44100:d=2[v1];sine=f=900:r=44100:d=2[v2];"
        "[s1][v1]concat=n=2:v=0:a=1[l];[s2][v2]concat=n=2:v=0:a=1[r];[l][r]join=inputs=2:channel_layout=stereo"
    )
    src = _make(tmp_path / "stereo.ogg", graph)
    result = preprocess(src, tmp_path, CONFIG, None)
    assert (result.split, result.channels, len(result.paths)) == (True, 2, 2)
    assert all(_wav(path)[:2] == (1, 16_000) for path in result.paths)
    # The same trim applies to both channels.
    assert len({round(_wav(path)[2], 2) for path in result.paths}) == 1


@needs_ffmpeg
def test_duplicated_mono_does_not_split(tmp_path: Path):
    src = _make(tmp_path / "duplicated.ogg", SPEECH + ",pan=stereo|c0=c0|c1=c0")
    result = preprocess(src, tmp_path, CONFIG, None)
    assert (result.split, _steps(result)["split_channels"]["reason"]) == (False, "dual_mono")


@needs_ffmpeg
def test_everything_off_only_converts(tmp_path: Path):
    src = _make(tmp_path / "speech.ogg", SPEECH)
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


@needs_ffmpeg
def test_audio_that_does_not_open(tmp_path: Path):
    src = tmp_path / "junk.ogg"
    src.write_bytes(b"not audio" * 100)
    with pytest.raises(PreprocessError) as info:
        preprocess(src, tmp_path, CONFIG, None)
    assert info.value.code == AUDIO_DECODE_FAILED


@needs_ffmpeg
def test_trim_that_fails_on_one_channel_trims_none(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    graph = (
        "anullsrc=r=44100:cl=mono:d=2,asplit[s1][s2];sine=f=300:r=44100:d=2[v1];sine=f=900:r=44100:d=2[v2];"
        "[s1][v1]concat=n=2:v=0:a=1[l];[s2][v2]concat=n=2:v=0:a=1[r];[l][r]join=inputs=2:channel_layout=stereo"
    )
    src = _make(tmp_path / "stereo.ogg", graph)
    real_run = module._run
    trims: list[str] = []

    def second_trim_fails(*args: str, **kwargs: Any) -> subprocess.CompletedProcess[str]:
        if any("atrim=" in arg for arg in args):
            trims.append(args[-1])
            if len(trims) == 2:
                return subprocess.CompletedProcess(args, 1, "", "simulated failure")
        return real_run(*args, **kwargs)

    monkeypatch.setattr(module, "_run", second_trim_fails)
    result = preprocess(src, tmp_path, CONFIG, None)
    assert len(trims) == 2
    assert (result.offset_ms, _steps(result)["trim_silence"]["state"]) == (0, "failed")
    # Both channels stay whole (4 s), and no temporary is left.
    assert [round(_wav(path)[2]) for path in result.paths] == [4, 4]
    assert not list(tmp_path.glob("*.trim.wav"))


ACCEPTED = {
    "ogg": b"OggS\x00\x02" + bytes(6),
    "webm": b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\xf7\x81",
    "m4a": b"\x00\x00\x00\x20ftypM4A ",
    "mov": b"\x00\x00\x00\x14ftypqt  ",
    "wav": b"RIFF\x24\x08\x00\x00WAVE",
    "flac": b"fLaC\x00\x00\x00\x22" + bytes(4),
    "mp3-id3": b"ID3\x04\x00\x00" + bytes(6),
    "mp3": b"\xff\xfb\x90\x64" + bytes(8),
    "aac": b"\xff\xf1\x50\x80" + bytes(8),
}
DEMUXER = {
    "ogg": "ogg",
    "webm": "matroska",
    "m4a": "mov",
    "mov": "mov",
    "wav": "wav",
    "flac": "flac",
    "mp3-id3": "mp3",
    "mp3": "mp3",
    "aac": "aac",
}
REFUSED = {
    "hls": b"#EXTM3U\n#EXT-X-VERSION:3\nhttp://example.test/a.ts\n",
    "concat": b"ffconcat version 1.0\nfile /etc/passwd\n",
    "sdp": b"v=0\no=- 0 0 IN IP4 127.0.0.1\nm=audio 5004 RTP/AVP 96\n",
    "riff-avi": b"RIFF\x00\x00\x00\x00AVI LIST",
    "unknown": b"not audio" * 10,
    "empty": b"",
}


@pytest.mark.parametrize("name", ACCEPTED)
def test_allowed_container_picks_the_demuxer_from_the_bytes(tmp_path: Path, name: str):
    src = tmp_path / "audio.bin"
    src.write_bytes(ACCEPTED[name])
    assert demuxer(src) == DEMUXER[name]


@pytest.mark.parametrize("name", REFUSED)
def test_container_outside_the_list_is_refused_before_ffmpeg(
    tmp_path: Path, name: str, monkeypatch: pytest.MonkeyPatch
):
    src = tmp_path / "audio.ogg"
    src.write_bytes(REFUSED[name])

    def no_subprocess(*_args: Any, **_kwargs: Any) -> None:
        pytest.fail("ffmpeg must not see a refused container")

    monkeypatch.setattr(module.subprocess, "run", no_subprocess)
    with pytest.raises(PreprocessError) as info:
        preprocess(src, tmp_path, CONFIG, None)
    assert info.value.code == AUDIO_DECODE_FAILED
    assert "lista permitida" in info.value.message


def test_timeout_grows_with_the_duration_up_to_the_ceiling():
    assert module._timeout(60_000) == module.FFMPEG_BASE_TIMEOUT_S + 60
    assert module._timeout(None) == module.FFMPEG_MAX_TIMEOUT_S
    assert module._timeout(10 * 3600 * 1000) == module.FFMPEG_MAX_TIMEOUT_S


def test_ffmpeg_that_exceeds_the_timeout_fails(monkeypatch: pytest.MonkeyPatch):
    def slow(*args: Any, **kwargs: Any) -> None:
        raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])

    monkeypatch.setattr(module.subprocess, "run", slow)
    result = module._run("-i", "x", timeout=5)
    assert result.returncode != 0
    assert "tempo limite" in result.stderr


@needs_ffmpeg
def test_input_carries_demuxer_and_protocol_whitelist(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    src = _make(tmp_path / "speech.ogg", SPEECH)
    calls: list[list[str]] = []
    real_run = subprocess.run

    def spy(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        assert kwargs.get("timeout")
        return real_run(command, **kwargs)

    monkeypatch.setattr(module.subprocess, "run", spy)
    preprocess(src, tmp_path, CONFIG, None)
    inputs = [c for c in calls if c[0] in {"ffmpeg", "ffprobe"} and "-version" not in c]
    assert inputs
    for command in inputs:
        assert command[command.index("-protocol_whitelist") + 1] == "file"
        assert command[command.index("-f") + 1] in {"ogg", "wav"}
