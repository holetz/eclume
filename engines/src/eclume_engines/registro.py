"""Log em JSON de uma linha no stdout, comum ao server, aos workers arq e ao worker GPU.

Cada linha leva `ts` (RFC 3339 UTC), `level`, `logger`, `msg` e, quando definidos no contexto,
`request_id`, `recording_id`, `revision` e `job_id`. O contexto vive em `ContextVar`: o middleware
da API define `request_id`, e cada função de job define os campos do job na entrada.
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

CONTEXTO: tuple[ContextVar[Any], ...] = (request_id, recording_id, revision, job_id)
LOGGERS = ("eclume_server", "eclume_worker", "eclume_engines", "uvicorn", "arq")
ACESSO_UVICORN = "uvicorn.access"


class FormatadorJson(logging.Formatter):
    """Formata o registro como um objeto JSON numa linha só."""

    def format(self, record: logging.LogRecord) -> str:  # noqa: D102 — contrato de logging.Formatter
        linha: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for var in CONTEXTO:
            valor = var.get()
            if valor is not None:
                linha[var.name] = valor
        if record.exc_info:
            linha["exc"] = self.formatException(record.exc_info)
        return json.dumps(linha, ensure_ascii=False, default=str)


def contexto_do_job(job: str | None, gravacao: str | None = None, rev: int | None = None) -> None:
    """Define os campos do job no contexto atual (a task do arq tem o próprio contexto)."""
    job_id.set(job)
    recording_id.set(gravacao)
    revision.set(rev)


def configurar_logs(level: int = logging.INFO, stream: TextIO | None = None) -> logging.Handler:
    """Põe um handler JSON no stdout para os loggers do eclume, do uvicorn e do arq.

    Idempotente: chamar de novo troca o handler em vez de duplicar linhas. O log de acesso do
    uvicorn fica calado, porque grava a query string (URLs assinadas); a API registra o próprio.
    """
    handler = logging.StreamHandler(stream or sys.stdout)
    handler.setFormatter(FormatadorJson())
    for name in (*LOGGERS, ACESSO_UVICORN):
        logger = logging.getLogger(name)
        for antigo in list(logger.handlers):
            logger.removeHandler(antigo)
        logger.propagate = False
        if name == ACESSO_UVICORN:
            logger.setLevel(logging.WARNING)
            continue
        logger.setLevel(level)
        logger.addHandler(handler)
    return handler
