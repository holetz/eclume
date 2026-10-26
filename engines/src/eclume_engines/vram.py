"""VRAM measurement through NVML.

CTranslate2 allocates outside torch, so `torch.cuda.max_memory_allocated` does not see the ASR. The
measure here is the whole device's usage minus the baseline before the job, sampled in a thread.
Another process using the GPU (the host's Jellyfin) enters the baseline or the peak.
"""

from __future__ import annotations

import contextlib
import threading
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterator

_MB = 1024 * 1024


class VramMonitor:
    """Read the free and used memory of a GPU; without NVML, every reading is `None`."""

    def __init__(self, device_index: int = 0, interval_s: float = 0.2) -> None:
        """Open NVML if it exists; its absence is not an error (dev without a GPU)."""
        self.interval_s = interval_s
        self._nvml: Any = None
        self._handle: Any = None
        with contextlib.suppress(Exception):
            import pynvml  # noqa: PLC0415 — `whisperx` extra, only present in the GPU image

            pynvml.nvmlInit()
            self._handle = pynvml.nvmlDeviceGetHandleByIndex(device_index)
            self._nvml = pynvml

    def _info(self) -> Any:  # noqa: ANN401 — NVML struct
        if self._nvml is None:
            return None
        return self._nvml.nvmlDeviceGetMemoryInfo(self._handle)

    def free_mb(self) -> int | None:
        """Free VRAM now, in MiB."""
        info = self._info()
        return None if info is None else int(info.free // _MB)

    def used_mb(self) -> int | None:
        """VRAM used now by all processes, in MiB."""
        info = self._info()
        return None if info is None else int(info.used // _MB)

    def snapshot(self) -> dict[str, Any] | None:
        """Name, total and used VRAM (MiB) and utilization (%) of the GPU now; `None` without NVML."""
        info = self._info()
        if info is None:
            return None
        name = self._nvml.nvmlDeviceGetName(self._handle)
        return {
            "gpu_name": name.decode() if isinstance(name, bytes) else str(name),
            "vram_total_mb": int(info.total // _MB),
            "vram_used_mb": int(info.used // _MB),
            "utilization_pct": float(self._nvml.nvmlDeviceGetUtilizationRates(self._handle).gpu),
        }

    @contextlib.contextmanager
    def track(self) -> Iterator[PeakVram]:
        """Sample the usage during the block; `PeakVram.mb` is the peak above the baseline."""
        peak = PeakVram(baseline=self.used_mb())
        if peak.baseline is None:
            yield peak
            return
        stop = threading.Event()

        def sample() -> None:
            while not stop.is_set():
                used = self.used_mb()
                if used is not None:
                    peak.observe(used)
                stop.wait(self.interval_s)

        thread = threading.Thread(target=sample, name="vram-sampler", daemon=True)
        thread.start()
        try:
            yield peak
        finally:
            stop.set()
            thread.join()
            used = self.used_mb()
            if used is not None:
                peak.observe(used)


class PeakVram:
    """Peak usage observed above the baseline."""

    def __init__(self, baseline: int | None) -> None:
        """Start with no observation; `mb` is `None` while there is no NVML."""
        self.baseline = baseline
        self.max_used: int | None = baseline

    def observe(self, used: int) -> None:
        """Record a sample of total usage."""
        if self.max_used is None or used > self.max_used:
            self.max_used = used

    @property
    def mb(self) -> int | None:
        """Peak above the baseline, in MiB."""
        if self.baseline is None or self.max_used is None:
            return None
        return max(0, self.max_used - self.baseline)


def initial_batch_size(free_mb: int | None) -> int:
    """Initial ASR batch size from the free VRAM: 4 with ≥ 3.5 GB, otherwise 2.

    Measured on the GTX 1660 SUPER (1 h of audio, `large-v3-turbo` `int8_float16`): batches 4, 8
    and 16 take the same time (357, 381 and 370 s), because the GPU already saturates at 4, but 16
    raises the VRAM peak from ~3.0 to ~3.9 GB. The small batch leaves headroom for the host's
    Jellyfin.
    """
    if free_mb is None or free_mb >= 3500:  # noqa: PLR2004 — measured in docs/project/worker-gpu.md
        return 4
    return 2
