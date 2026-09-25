"""Medição de VRAM pela NVML.

O CTranslate2 aloca fora do torch, então `torch.cuda.max_memory_allocated` não enxerga o ASR. A
medida aqui é o uso do dispositivo inteiro menos a linha de base anterior ao job, amostrado numa
thread. Outro processo usando a GPU (o Jellyfin do host) entra na linha de base ou no pico.
"""

from __future__ import annotations

import contextlib
import threading
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterator

_MB = 1024 * 1024


class VramMonitor:
    """Lê memória livre e usada de uma GPU; sem NVML, todas as leituras são `None`."""

    def __init__(self, device_index: int = 0, interval_s: float = 0.2) -> None:
        """Abre a NVML se ela existir; a ausência não é erro (dev sem GPU)."""
        self.interval_s = interval_s
        self._nvml: Any = None
        self._handle: Any = None
        with contextlib.suppress(Exception):
            import pynvml  # noqa: PLC0415 — extra `whisperx`, só existe na imagem GPU

            pynvml.nvmlInit()
            self._handle = pynvml.nvmlDeviceGetHandleByIndex(device_index)
            self._nvml = pynvml

    def _info(self) -> Any:  # noqa: ANN401 — struct da NVML
        if self._nvml is None:
            return None
        return self._nvml.nvmlDeviceGetMemoryInfo(self._handle)

    def free_mb(self) -> int | None:
        """VRAM livre agora, em MiB."""
        info = self._info()
        return None if info is None else int(info.free // _MB)

    def used_mb(self) -> int | None:
        """VRAM usada agora por todos os processos, em MiB."""
        info = self._info()
        return None if info is None else int(info.used // _MB)

    @contextlib.contextmanager
    def track(self) -> Iterator[PeakVram]:
        """Amostra o uso durante o bloco; `PeakVram.mb` é o pico acima da linha de base."""
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
    """Pico de uso observado acima da linha de base."""

    def __init__(self, baseline: int | None) -> None:
        """Começa sem observação; `mb` é `None` enquanto não houver NVML."""
        self.baseline = baseline
        self.max_used: int | None = baseline

    def observe(self, used: int) -> None:
        """Registra uma amostra de uso total."""
        if self.max_used is None or used > self.max_used:
            self.max_used = used

    @property
    def mb(self) -> int | None:
        """Pico acima da linha de base, em MiB."""
        if self.baseline is None or self.max_used is None:
            return None
        return max(0, self.max_used - self.baseline)


def initial_batch_size(free_mb: int | None) -> int:
    """Lote inicial do ASR pela VRAM livre: 16 com ≥ 5 GB, 8 com ≥ 3,5 GB, senão 4."""
    if free_mb is None:
        return 8
    if free_mb >= 5000:  # noqa: PLR2004 — faixas da spec holetz/eclume#8
        return 16
    if free_mb >= 3500:  # noqa: PLR2004
        return 8
    return 4
