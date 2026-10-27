"""What counts as a transient Postgres and S3 failure in the GPU worker's return jobs."""

from __future__ import annotations

import json
import socket

import pytest
from botocore.exceptions import ClientError, ConnectTimeoutError, EndpointConnectionError, ReadTimeoutError
from sqlalchemy.exc import DBAPIError, IntegrityError, InterfaceError, OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError

from eclume_server.transient import is_transient


class _PgError(Exception):
    """Driver error carrying the SQLSTATE, as the asyncpg adapter exposes it."""

    def __init__(self, sqlstate: str) -> None:
        super().__init__(sqlstate)
        self.sqlstate = sqlstate


def _client_error(code: str, status: int) -> ClientError:
    return ClientError({"Error": {"Code": code}, "ResponseMetadata": {"HTTPStatusCode": status}}, "GetObject")


def _wrapped(cause: BaseException) -> RuntimeError:
    exc = RuntimeError("na ingestão")
    exc.__cause__ = cause
    return exc


@pytest.mark.parametrize(
    "exc",
    [
        ConnectionRefusedError("recusada"),
        ConnectionResetError("caída"),
        TimeoutError("timeout"),
        socket.gaierror("nome não resolve"),
        EndpointConnectionError(endpoint_url="http://minio:9000"),
        ConnectTimeoutError(endpoint_url="http://minio:9000"),
        ReadTimeoutError(endpoint_url="http://minio:9000"),
        _client_error("InternalError", 500),
        _client_error("SlowDown", 503),
        PoolTimeoutError("pool esgotado"),
        OperationalError("SELECT 1", {}, Exception("servidor caiu")),
        InterfaceError("SELECT 1", {}, Exception("conexão fechada")),
        DBAPIError("SELECT 1", {}, Exception("x"), connection_invalidated=True),
        DBAPIError("UPDATE", {}, _PgError("40P01")),
        DBAPIError("UPDATE", {}, _PgError("40001")),
        DBAPIError("SELECT 1", {}, _PgError("08006")),
        _wrapped(ConnectionRefusedError("recusada")),
    ],
    ids=lambda exc: type(exc).__name__,
)
def test_transient(exc: BaseException):
    assert is_transient(exc)


@pytest.mark.parametrize(
    "exc",
    [
        ValueError("dado inválido"),
        json.JSONDecodeError("JSON malformado", "{", 0),
        KeyError("speakers"),
        _client_error("NoSuchKey", 404),
        _client_error("AccessDenied", 403),
        IntegrityError("INSERT", {}, _PgError("23505")),
        DBAPIError("SELECT", {}, _PgError("22P02")),
        _wrapped(ValueError("dado inválido")),
    ],
    ids=lambda exc: type(exc).__name__,
)
def test_permanent(exc: BaseException):
    assert not is_transient(exc)
