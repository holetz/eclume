"""Job progress in Redis: `HSET eclume:progress:{recording_id}` with a 1-day TTL.

`pct` is the job's overall percentage, monotonic, with one range per stage. `started_at` is the
job start, the same on every write of the hash. `revision` says which revision the progress belongs
to, so the server ignores another revision's.
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
    """Key of the progress hash."""
    return f"eclume:progress:{recording_id}"


def overall_pct(stage: str, stage_pct: float) -> int:
    """Convert the stage percentage into the job's overall percentage."""
    low, high = STAGE_RANGES[stage]
    fraction = min(100.0, max(0.0, stage_pct)) / 100
    return int(low + (high - low) * fraction)


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _rfc3339(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


class ProgressReporter:
    """Write the progress only when the overall `pct` or the stage changes."""

    def __init__(
        self,
        redis: Any,  # noqa: ANN401 — redis.asyncio.Redis ou ArqRedis
        recording_id: str,
        revision: int,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        """`redis` is arq's async client."""
        self.redis = redis
        self.recording_id = recording_id
        self.key = progress_key(recording_id)
        self.revision = revision
        self.clock = clock
        self.started_at = _rfc3339(clock())
        self._last: tuple[str, int] | None = None
        self._pct = 0

    @property
    def stage(self) -> str | None:
        """The last stage recorded (the failing one, when the job fails)."""
        return self._last[0] if self._last else None

    async def report(self, stage: str, stage_pct: float = 0.0) -> None:
        """Record the stage; `pct` never goes back."""
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
