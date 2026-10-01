"""Progresso do job em Redis: `HSET eclume:progress:{recording_id}` com TTL de 1 dia.

O `pct` é o geral do job, monotônico, com uma faixa por etapa. `started_at` é o início do job,
igual em toda gravação do hash. `revision` diz de qual revisão é o progresso, para o server ignorar
o de outra revisão.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable

PROGRESS_TTL_SECONDS = 86_400
STAGE_RANGES: dict[str, tuple[float, float]] = {
    "download": (0, 3),
    "preprocess": (3, 10),
    "asr": (10, 55),
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


def _rfc3339(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


class ProgressReporter:
    """Grava o progresso só quando o `pct` geral ou a etapa mudam."""

    def __init__(
        self,
        redis: Any,  # noqa: ANN401 — redis.asyncio.Redis ou ArqRedis
        recording_id: str,
        revision: int,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        """`redis` é o cliente assíncrono do arq."""
        self.redis = redis
        self.key = progress_key(recording_id)
        self.revision = revision
        self.clock = clock
        self.started_at = _rfc3339(clock())
        self._last: tuple[str, int] | None = None
        self._pct = 0

    @property
    def stage(self) -> str | None:
        """A última etapa registrada (a da falha, quando o job falha)."""
        return self._last[0] if self._last else None

    async def report(self, stage: str, stage_pct: float = 0.0) -> None:
        """Registra a etapa; o `pct` nunca recua."""
        self._pct = max(self._pct, overall_pct(stage, stage_pct))
        if self._last == (stage, self._pct):
            return
        self._last = (stage, self._pct)
        mapping = {
            "revision": self.revision,
            "stage": stage,
            "pct": self._pct,
            "started_at": self.started_at,
            "updated_at": _rfc3339(self.clock()),
        }
        await self.redis.hset(self.key, mapping=mapping)
        await self.redis.expire(self.key, PROGRESS_TTL_SECONDS)
