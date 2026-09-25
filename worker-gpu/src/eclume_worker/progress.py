"""Progresso do job em Redis: `HSET eclume:progress:{recording_id}` com TTL de 1 dia.

O `pct` é o geral do job, monotônico, com uma faixa por etapa.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable

PROGRESS_TTL_SECONDS = 86_400
STAGE_RANGES: dict[str, tuple[float, float]] = {
    "download": (0, 5),
    "asr": (5, 55),
    "align": (55, 70),
    "diarize": (70, 90),
    "embed": (90, 95),
    "upload": (95, 100),
}


def progress_key(recording_id: str) -> str:
    """Chave do hash de progresso."""
    return f"eclume:progress:{recording_id}"


def overall_pct(stage: str, stage_pct: float) -> int:
    """Converte o percentual da etapa no percentual geral do job."""
    low, high = STAGE_RANGES[stage]
    fraction = min(100.0, max(0.0, stage_pct)) / 100
    return int(low + (high - low) * fraction)


def _utc_now() -> datetime:
    return datetime.now(UTC)


class ProgressReporter:
    """Grava o progresso só quando o `pct` geral ou a etapa mudam."""

    def __init__(self, redis: Any, recording_id: str, clock: Callable[[], datetime] = _utc_now) -> None:  # noqa: ANN401 — redis.asyncio.Redis ou ArqRedis
        """`redis` é o cliente assíncrono do arq."""
        self.redis = redis
        self.key = progress_key(recording_id)
        self.clock = clock
        self._last: tuple[str, int] | None = None
        self._pct = 0

    async def report(self, stage: str, stage_pct: float = 0.0) -> None:
        """Registra a etapa; o `pct` nunca recua."""
        self._pct = max(self._pct, overall_pct(stage, stage_pct))
        if self._last == (stage, self._pct):
            return
        self._last = (stage, self._pct)
        updated_at = self.clock().isoformat().replace("+00:00", "Z")
        await self.redis.hset(self.key, mapping={"stage": stage, "pct": self._pct, "updated_at": updated_at})
        await self.redis.expire(self.key, PROGRESS_TTL_SECONDS)
