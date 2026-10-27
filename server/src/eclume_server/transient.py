"""Transient Postgres or S3 failure: what the GPU worker's callback jobs retry.

Transient means a refused, dropped or timed-out connection (to Postgres or S3), an exhausted pool,
S3 answering 5xx or `SlowDown`, and a Postgres deadlock or serialization failure. Everything else —
invalid data, malformed JSON, `NoSuchKey`, an integrity violation — is permanent: retrying would give
the same error. Contract in `docs/standards/api/jobs-transcricao.md` `§O server ingere`.
"""

from __future__ import annotations

import socket

from botocore.exceptions import ClientError, HTTPClientError
from botocore.exceptions import ConnectionError as BotoConnectionError
from sqlalchemy.exc import DBAPIError, InterfaceError, OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError

# SQLSTATE: connection (class 08), deadlock, serialization, exhausted connections and the server shutting down.
_SQLSTATE_PREFIXES = ("08", "40001", "40P01", "53300", "57P01", "57P02", "57P03")
_S3_TRANSIENT_CODES = frozenset({"SlowDown", "RequestTimeout", "ServiceUnavailable", "InternalError"})
_HTTP_SERVER_ERROR = 500
# How many links of the cause chain to look at (the chain may have a cycle).
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
    """Whether `exc` (or one of its causes: `__cause__`, `orig`) is a transient Postgres or S3 failure."""
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
