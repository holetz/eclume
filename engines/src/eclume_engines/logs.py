"""One-line JSON log on stdout, shared by the server, the arq workers and the GPU worker.

Each line carries `ts` (RFC 3339 UTC), `level`, `logger`, `msg` and, when set in the context,
`request_id`, `recording_id`, `revision` and `job_id`. The context lives in `ContextVar`s: the API
middleware sets `request_id`, and each job function sets the job fields on entry.
"""

from __future__ import annotations

import json
import logging
import sys
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any, TextIO

request_id: ContextVar[str | None] = ContextVar("request_id", default=None)
recording_id: ContextVar[str | None] = ContextVar("recording_id", default=None)
revision: ContextVar[int | None] = ContextVar("revision", default=None)
job_id: ContextVar[str | None] = ContextVar("job_id", default=None)

CONTEXT: tuple[ContextVar[Any], ...] = (request_id, recording_id, revision, job_id)
LOGGERS = ("eclume_server", "eclume_worker", "eclume_engines", "uvicorn", "arq")
UVICORN_ACCESS = "uvicorn.access"
ARQ_LOGGER = "arq.worker"


class JsonFormatter(logging.Formatter):
    """Format the record as a single-line JSON object."""

    def format(self, record: logging.LogRecord) -> str:  # noqa: D102 — logging.Formatter contract
        line: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for var in CONTEXT:
            value = var.get()
            if value is not None:
                line[var.name] = value
        if record.exc_info:
            line["exc"] = self.formatException(record.exc_info)
        return json.dumps(line, ensure_ascii=False, default=str)


def job_context(job: str | None, recording: str | None = None, rev: int | None = None) -> None:
    """Set the job fields in the current context (each arq job runs in its own task).

    Without `recording`, read the recording and revision from the `_job_id`
    `{job}:{recording_id}:{revision}`; an id in another shape (summary, sweep, random arq id) only
    fills `job_id`.
    """
    if recording is None and job:
        parts = job.split(":")
        if len(parts) == 3 and parts[2].isdigit():  # noqa: PLR2004 — the three parts of the id
            recording, rev = parts[1], int(parts[2])
    job_id.set(job)
    recording_id.set(recording)
    revision.set(rev)


class NoArqCron(logging.Filter):
    """Silence the INFO of arq cron runs (`cron:<function>`), which run every minute or less.

    Failures, retries and any WARNING-and-above record pass; ordinary job functions stay at INFO.
    """

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: D102 — logging.Filter contract
        if record.levelno >= logging.WARNING or not isinstance(record.args, tuple):
            return True
        return not any(isinstance(arg, str) and "cron:" in arg for arg in record.args)


def configure_logs(level: int = logging.INFO, stream: TextIO | None = None) -> logging.Handler:
    """Put a JSON handler on stdout for the eclume, uvicorn and arq loggers.

    Idempotent: calling it again replaces the handler instead of duplicating lines. The uvicorn
    access log stays silent, because it records the query string (signed URLs); the API logs its own.
    """
    handler = logging.StreamHandler(stream or sys.stdout)
    handler.setFormatter(JsonFormatter())
    for name in (*LOGGERS, UVICORN_ACCESS):
        logger = logging.getLogger(name)
        for old in list(logger.handlers):
            logger.removeHandler(old)
        logger.propagate = False
        if name == UVICORN_ACCESS:
            logger.setLevel(logging.WARNING)
            continue
        logger.setLevel(level)
        logger.addHandler(handler)
    arq = logging.getLogger(ARQ_LOGGER)
    for old in [f for f in arq.filters if isinstance(f, NoArqCron)]:
        arq.removeFilter(old)
    arq.addFilter(NoArqCron())
    return handler
