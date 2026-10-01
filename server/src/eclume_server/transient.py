"""Falha passageira de Postgres ou S3: o que os jobs de retorno do worker GPU tentam de novo.

Passageira é a conexão recusada, caída ou com timeout (com o Postgres ou o S3), o pool esgotado, o
S3 respondendo 5xx ou `SlowDown`, e o deadlock ou a falha de serialização do Postgres. O resto —
dado inválido, JSON malformado, `NoSuchKey`, violação de integridade — é definitivo: repetir daria
o mesmo erro. Contrato em docs/standards/api/jobs-transcricao.md §O server ingere.
"""

from __future__ import annotations

import socket

from botocore.exceptions import ClientError, HTTPClientError
from botocore.exceptions import ConnectionError as BotoConnectionError
from sqlalchemy.exc import DBAPIError, InterfaceError, OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError

# SQLSTATE: conexão (classe 08), deadlock, serialização, conexões esgotadas e o servidor parando.
_SQLSTATE_PREFIXES = ("08", "40001", "40P01", "53300", "57P01", "57P02", "57P03")
_S3_TRANSIENT_CODES = frozenset({"SlowDown", "RequestTimeout", "ServiceUnavailable", "InternalError"})
_HTTP_SERVER_ERROR = 500
# Quantos elos da cadeia de causas olhar (a cadeia pode ter ciclo).
_MAX_CHAIN = 8


_NETWORK = (ConnectionError, TimeoutError, socket.gaierror, BotoConnectionError, HTTPClientError, PoolTimeoutError)


def _transient_one(exc: BaseException) -> bool:
    if isinstance(exc, _NETWORK):
        return True
    if isinstance(exc, ClientError):
        error = exc.response.get("Error", {})
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode") or 0
        return status >= _HTTP_SERVER_ERROR or error.get("Code") in _S3_TRANSIENT_CODES
    if isinstance(exc, (OperationalError, InterfaceError)):
        return True
    if isinstance(exc, DBAPIError) and exc.connection_invalidated:
        return True
    sqlstate = getattr(exc, "sqlstate", None) or getattr(exc, "pgcode", None)
    return isinstance(sqlstate, str) and sqlstate.startswith(_SQLSTATE_PREFIXES)


def is_transient(exc: BaseException) -> bool:
    """Se `exc` (ou uma causa dela: `__cause__`, `orig`) é falha passageira de Postgres ou S3."""
    seen: set[int] = set()
    pending: list[BaseException] = [exc]
    while pending and len(seen) < _MAX_CHAIN:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if _transient_one(current):
            return True
        pending.extend(
            cause for cause in (current.__cause__, getattr(current, "orig", None)) if isinstance(cause, BaseException)
        )
    return False
