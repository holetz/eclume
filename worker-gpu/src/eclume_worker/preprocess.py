# ruff: noqa: S603, S607 — ffmpeg and ffprobe from PATH, with arguments built here and no shell
"""Audio preprocessing before the ASR, with the image's `ffmpeg`.

The configuration arrives in `options.preprocess` (the platform's `preprocessing` block). The order
is fixed: split channels (only two-source stereo), 48 kHz, noise reduction, loudness normalization
and 16 kHz mono at the end; then, trimming the silence at the start and at the end, measured
already normalized. The processed audio lives only in the working directory: the bucket keeps the
original, the one the user hears, and the trim offset goes back into the time marks. Contract in
docs/standards/api/jobs-transcricao.md.

The container is chosen from the initial bytes, in an allow list, and reaches `ffprobe` and
`ffmpeg` with an explicit `-f` and `-protocol_whitelist file`: ffmpeg never guesses the format, so
HLS playlists, `concat`, SDP and the like open nothing beyond the file itself. Every process has a
timeout.
"""

from __future__ import annotations

import json
import re
import subprocess
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

AUDIO_DECODE_FAILED = "audio_decode_failed"
PREPROCESS_FAILED = "preprocess_failed"
WARN_RNNOISE_MODEL_MISSING = "rnnoise_model_missing"
SAMPLE_RATE = 16_000
# Difference between the channels below this: it is the same signal in both (duplicated mono).
DUAL_MONO_DB = -60.0
_STDERR_TAIL = 600
# Tolerance (s) for a silence to "start at the start" or "end at the end".
_EDGE_S = 0.05

_SILENCE_START = re.compile(r"silence_start: (-?[\d.]+)")
_SILENCE_END = re.compile(r"silence_end: (-?[\d.]+)")
_MEAN_VOLUME = re.compile(r"mean_volume: (-?[\d.]+|-inf) dB")

PROBE_TIMEOUT_S = 60.0
# Ceiling of each ffmpeg: a base plus the audio duration (real time), or the maximum if it is unknown.
FFMPEG_BASE_TIMEOUT_S = 300.0
FFMPEG_MAX_TIMEOUT_S = 4 * 3600.0
_HEAD_BYTES = 12
# The processed audio in the working directory is always a WAV generated here.
_WAV = "wav"
# The allowed containers: (position, magic bytes, ffmpeg demuxer). MPEG and ADTS come separately.
_MAGIC = (
    (0, b"OggS", "ogg"),
    (0, b"\x1a\x45\xdf\xa3", "matroska"),  # Matroska e WebM
    (4, b"ftyp", "mov"),  # MP4, MOV, M4A
    (0, b"RIFF", _WAV),  # with `WAVE` at position 8
    (0, b"fLaC", "flac"),
    (0, b"ID3", "mp3"),
)


class PreprocessError(Exception):
    """The audio does not open even when only converted: the job fails with `audio_decode_failed`."""

    def __init__(self, message: str) -> None:
        """Message with the tail of ffmpeg's stderr."""
        super().__init__(message)
        self.code = AUDIO_DECODE_FAILED
        self.message = message


@dataclass
class PreprocessResult:
    """The files for the ASR (one per separated channel) and what was done, for the `engine_info`."""

    paths: list[Path]
    offset_ms: int
    channels: int
    split: bool
    fallback: bool
    steps: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    ms: int = 0
    ffmpeg_version: str | None = None
    # The duration of the original (ffprobe), the one the user hears; `None` if the container does not state it.
    duration_ms: int | None = None

    def info(self) -> dict[str, Any]:
        """O `engine_info.preprocess`."""
        return {
            "steps": self.steps,
            "ms": self.ms,
            "offset_ms": self.offset_ms,
            "channels": self.channels,
            "split": self.split,
            "fallback": self.fallback,
            "warnings": self.warnings,
            "ffmpeg_version": self.ffmpeg_version,
        }


def demuxer(path: Path) -> str:
    """The ffmpeg demuxer for the container from the initial bytes; `PreprocessError` outside the list."""
    with path.open("rb") as audio:
        head = audio.read(_HEAD_BYTES)
    for offset, magic, fmt in _MAGIC:
        if head[offset : offset + len(magic)] == magic and (fmt != _WAV or head[8:12] == b"WAVE"):
            return fmt
    if len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0:  # noqa: PLR2004 — MPEG sync
        # Layer 00 is the ADTS header (AAC); the others are MPEG audio (MP3).
        return "aac" if head[1] & 0x06 == 0 else "mp3"
    msg = f"contêiner fora da lista permitida (bytes iniciais {head[:8].hex()})"
    raise PreprocessError(msg)


def _input(path: Path, fmt: str) -> list[str]:
    """The input with an explicit demuxer and only the `file` protocol."""
    return ["-protocol_whitelist", "file", "-f", fmt, "-i", f"file:{path}"]


def _timeout(duration_ms: int | None) -> float:
    if duration_ms is None:
        return FFMPEG_MAX_TIMEOUT_S
    return min(FFMPEG_BASE_TIMEOUT_S + duration_ms / 1000, FFMPEG_MAX_TIMEOUT_S)


def _run(*args: str, timeout: float = FFMPEG_MAX_TIMEOUT_S) -> subprocess.CompletedProcess[str]:
    """Run ffmpeg; exceeding the timeout is a failure like any other (code -1)."""
    command = ["ffmpeg", "-hide_banner", "-nostdin", *args]
    try:
        return subprocess.run(command, capture_output=True, text=True, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(command, -1, "", f"tempo limite de {timeout:g} s esgotado")


def _tail(stderr: str) -> str:
    return stderr.strip()[-_STDERR_TAIL:]


def ffmpeg_version() -> str | None:
    """The ffmpeg version (`6.1.1-3ubuntu5`), or `None` without ffmpeg."""
    try:
        out = subprocess.run(
            ["ffmpeg", "-version"], capture_output=True, text=True, check=False, timeout=PROBE_TIMEOUT_S
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = re.match(r"ffmpeg version (\S+)", out)
    return match.group(1) if match else None


def probe(path: Path, fmt: str) -> tuple[int, int | None]:
    """Channels of the first audio stream and the file's duration (ms); `PreprocessError` if it does not open."""
    command = [
        "ffprobe",
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-f",
        fmt,
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=channels:format=duration",
        "-of",
        "json",
        f"file:{path}",
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False, timeout=PROBE_TIMEOUT_S)
    except subprocess.TimeoutExpired as exc:
        msg = f"o áudio não abre: ffprobe passou de {PROBE_TIMEOUT_S:g} s"
        raise PreprocessError(msg) from exc
    try:
        data = json.loads(result.stdout)
        channels = int(data["streams"][0]["channels"])
    except (ValueError, KeyError, IndexError) as exc:
        msg = f"o áudio não abre: {_tail(result.stderr)}"
        raise PreprocessError(msg) from exc
    try:
        duration_ms = round(float(data["format"]["duration"]) * 1000)
    except (ValueError, KeyError, TypeError):
        duration_ms = None
    return channels, duration_ms


def _dual_mono(path: Path, fmt: str, timeout: float) -> bool:
    """Both channels carry the same signal: the difference between them is silence."""
    result = _run(*_input(path, fmt), "-af", "pan=mono|c0=c0-c1,volumedetect", "-f", "null", "-", timeout=timeout)
    match = _MEAN_VOLUME.search(result.stderr)
    return bool(match) and (match.group(1) == "-inf" or float(match.group(1)) < DUAL_MONO_DB)


def _enabled(config: dict[str, Any], step: str) -> dict[str, Any] | None:
    block = config.get(step) or {}
    return block if block.get("enabled") else None


def _chain(config: dict[str, Any], model: str | None, warnings: list[str]) -> tuple[list[str], list[dict[str, Any]]]:
    """The filters after the channel choice, in the fixed order, and the record of each step."""
    filters = ["aresample=48000"]
    steps: list[dict[str, Any]] = []
    denoise = _enabled(config, "denoise")
    if denoise is None:
        steps.append({"step": "denoise", "state": "skipped", "reason": "disabled"})
    else:
        strength = float(denoise.get("strength", 0.6))
        method = denoise.get("method", "rnnoise")
        if method == "rnnoise" and not (model and Path(model).is_file()):
            warnings.append(WARN_RNNOISE_MODEL_MISSING)
            method = "afftdn"
        if method == "rnnoise":
            filters.append(f"arnndn=m={model}:mix={strength:g}")
        else:
            filters.append(f"afftdn=nr={6 + 24 * strength:g}:nf=-50")
        steps.append({"step": "denoise", "state": "done", "params": {"method": method, "strength": strength}})
    loudnorm = _enabled(config, "loudnorm")
    if loudnorm is None:
        steps.append({"step": "loudnorm", "state": "skipped", "reason": "disabled"})
    else:
        params = {key: float(loudnorm[key]) for key in ("target_lufs", "true_peak_db", "lra")}
        filters.append(f"loudnorm=I={params['target_lufs']:g}:TP={params['true_peak_db']:g}:LRA={params['lra']:g}")
        steps.append({"step": "loudnorm", "state": "done", "params": params})
    filters.append(f"aresample={SAMPLE_RATE}")
    return filters, steps


def _render(  # noqa: PLR0913 — the input, the output, the chain and the ceiling of each call
    src: Path, fmt: str, dst: Path, pick: str, filters: list[str], *, timeout: float
) -> subprocess.CompletedProcess[str]:
    return _run(
        "-y",
        *_input(src, fmt),
        "-af",
        ",".join([pick, *filters]),
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        str(dst),
        timeout=timeout,
    )


def _silences(path: Path, threshold_db: float, min_silence_s: float, timeout: float) -> tuple[float, float | None]:
    """`(speech start, speech end or None)` from `silencedetect` on the already normalized file."""
    result = _run(
        *_input(path, _WAV),
        "-af",
        f"silencedetect=noise={threshold_db:g}dB:d={min_silence_s:g}",
        "-f",
        "null",
        "-",
        timeout=timeout,
    )
    starts = [float(v) for v in _SILENCE_START.findall(result.stderr)]
    ends = [float(v) for v in _SILENCE_END.findall(result.stderr)]
    with wave.open(str(path)) as audio:
        duration = audio.getnframes() / audio.getframerate()
    speech_start = ends[0] if starts and starts[0] <= _EDGE_S and ends else 0.0
    speech_end = None
    # The last silence runs to the end: without `silence_end` (old ffmpeg) or with it at the end of the file.
    if starts and (len(ends) < len(starts) or ends[-1] >= duration - _EDGE_S) and starts[-1] > speech_start:
        speech_end = starts[-1]
    return speech_start, speech_end


def _trim(paths: list[Path], config: dict[str, Any], timeout: float) -> tuple[float, dict[str, Any]]:
    """Trim the same interval from all files; return the offset (s) and the step."""
    trim = _enabled(config, "trim_silence")
    if trim is None:
        return 0.0, {"step": "trim_silence", "state": "skipped", "reason": "disabled"}
    threshold, minimum = float(trim["threshold_db"]), float(trim["min_silence_s"])
    found = [_silences(path, threshold, minimum, timeout) for path in paths]
    start = min(begin for begin, _ in found)
    ends = [end for _, end in found]
    end = None if any(e is None for e in ends) else max(e for e in ends if e is not None)
    params = {"threshold_db": threshold, "min_silence_s": minimum, "start_s": round(start, 3)}
    if end is not None:
        params["end_s"] = round(end, 3)
    if start <= 0 and end is None:
        return 0.0, {"step": "trim_silence", "state": "skipped", "reason": "no_silence", "params": params}
    if end is not None and end <= start:
        return 0.0, {"step": "trim_silence", "state": "skipped", "reason": "all_silence", "params": params}
    window = f"atrim=start={start:.3f}" + (f":end={end:.3f}" if end is not None else "")
    # All channels trimmed into temporaries and swapped only at the end: either all come out trimmed
    # (with the offset), or none do.
    trimmed = [path.with_name(path.stem + ".trim.wav") for path in paths]
    for path, target in zip(paths, trimmed, strict=True):
        result = _run(
            "-y",
            *_input(path, _WAV),
            "-af",
            f"{window},asetpts=PTS-STARTPTS",
            "-c:a",
            "pcm_s16le",
            str(target),
            timeout=timeout,
        )
        if result.returncode != 0:
            for leftover in trimmed:
                leftover.unlink(missing_ok=True)
            return 0.0, {"step": "trim_silence", "state": "failed", "error": _tail(result.stderr), "params": params}
    for path, target in zip(paths, trimmed, strict=True):
        target.replace(path)
    return start, {"step": "trim_silence", "state": "done", "params": params}


def preprocess(src: Path, workdir: Path, config: dict[str, Any] | None, model: str | None) -> PreprocessResult:
    """Process `src` for the ASR; without a configuration (old server), only convert the format.

    On a chain failure: redo only the format (16 kHz mono) and mark the step failed; if even that
    fails, `PreprocessError`, like a container outside the allow list.
    """
    started = time.monotonic()
    config = config or {}
    fmt = demuxer(src)
    channels, duration_ms = probe(src, fmt)
    timeout = _timeout(duration_ms)
    warnings: list[str] = []
    steps: list[dict[str, Any]] = [
        {"step": "resample", "state": "done", "params": {"rate": SAMPLE_RATE, "channels": 1}}
    ]
    picks = ["aformat=channel_layouts=mono"]
    if _enabled(config, "split_channels") is None:
        steps.append({"step": "split_channels", "state": "skipped", "reason": "disabled"})
    elif channels != 2:  # noqa: PLR2004 — only two-source stereo
        steps.append({"step": "split_channels", "state": "skipped", "reason": "not_stereo"})
    elif _dual_mono(src, fmt, timeout):
        steps.append({"step": "split_channels", "state": "skipped", "reason": "dual_mono"})
    else:
        picks = ["pan=mono|c0=c0", "pan=mono|c0=c1"]
        steps.append({"step": "split_channels", "state": "done"})
    filters, chain_steps = _chain(config, model, warnings)
    paths = [workdir / f"pre.{n}.wav" for n in range(len(picks))]
    results = [_render(src, fmt, path, pick, filters, timeout=timeout) for pick, path in zip(picks, paths, strict=True)]
    fallback = any(result.returncode != 0 for result in results)
    if fallback:
        error = _tail(next(r.stderr for r in results if r.returncode != 0))
        chain_steps = [
            {**step, "state": "failed", "error": error} if step["state"] == "done" else step for step in chain_steps
        ]
        warnings.append(PREPROCESS_FAILED)
        results = [
            _render(src, fmt, path, pick, [f"aresample={SAMPLE_RATE}"], timeout=timeout)
            for pick, path in zip(picks, paths, strict=True)
        ]
        failed = next((r for r in results if r.returncode != 0), None)
        if failed is not None:
            msg = f"o áudio não abre nem só convertido: {_tail(failed.stderr)}"
            raise PreprocessError(msg)
    steps += chain_steps
    offset, trim_step = _trim(paths, config, timeout)
    steps.append(trim_step)
    return PreprocessResult(
        paths=paths,
        offset_ms=round(offset * 1000),
        channels=channels,
        split=len(paths) > 1,
        fallback=fallback,
        steps=steps,
        warnings=warnings,
        ms=round((time.monotonic() - started) * 1000),
        ffmpeg_version=ffmpeg_version(),
        duration_ms=duration_ms,
    )
