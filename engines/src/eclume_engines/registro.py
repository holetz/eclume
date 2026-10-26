"""Deprecated alias of `eclume_engines.logs`, kept until the server imports the English names."""

from eclume_engines.logs import (
    ARQ_LOGGER,
    CONTEXT,
    LOGGERS,
    UVICORN_ACCESS,
    JsonFormatter,
    NoArqCron,
    configure_logs,
    job_context,
    job_id,
    recording_id,
    request_id,
    revision,
)
from eclume_engines.logs import configure_logs as configurar_logs
from eclume_engines.logs import job_context as contexto_do_job

__all__ = [
    "ARQ_LOGGER",
    "CONTEXT",
    "LOGGERS",
    "UVICORN_ACCESS",
    "JsonFormatter",
    "NoArqCron",
    "configurar_logs",
    "configure_logs",
    "contexto_do_job",
    "job_context",
    "job_id",
    "recording_id",
    "request_id",
    "revision",
]
