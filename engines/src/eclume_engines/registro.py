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
LOGGER_ARQ = "arq.worker"


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
    """Define os campos do job no contexto atual (cada job do arq roda na própria task).

    Sem `gravacao`, lê gravação e revisão do `_job_id` `{job}:{recording_id}:{revision}`; um id em
    outra forma (resumo, varredura, id aleatório do arq) só preenche `job_id`.
    """
    if gravacao is None and job:
        partes = job.split(":")
        if len(partes) == 3 and partes[2].isdigit():  # noqa: PLR2004 — as três partes do id
            gravacao, rev = partes[1], int(partes[2])
    job_id.set(job)
    recording_id.set(gravacao)
    revision.set(rev)


class SemCronDoArq(logging.Filter):
    """Cala o INFO das execuções de cron do arq (`cron:<função>`), que rodam a cada minuto ou menos.

    Falha, nova tentativa e qualquer registro de WARNING para cima passam; as funções de job comuns
    seguem em INFO.
    """

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: D102 — contrato de logging.Filter
        if record.levelno >= logging.WARNING or not isinstance(record.args, tuple):
            return True
        return not any(isinstance(arg, str) and "cron:" in arg for arg in record.args)


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
    arq = logging.getLogger(LOGGER_ARQ)
    for antigo in [f for f in arq.filters if isinstance(f, SemCronDoArq)]:
        arq.removeFilter(antigo)
    arq.addFilter(SemCronDoArq())
    return handler
