"""Harness de serviços da suíte do server: Postgres, Redis e MinIO reais.

Os serviços vêm de `deploy/docker-compose.test.yml`. Cada sessão de teste cria um banco, um
bucket e escolhe um banco do Redis próprios, e desfaz tudo no fim.
"""

from __future__ import annotations

import asyncio
import os
import secrets
import socket
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

import boto3
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from eclume_server.config import Settings
from eclume_server.db.migrate import migrate

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Coroutine

DATABASE_URL = os.environ.get("ECLUME_TEST_DATABASE_URL", "postgresql+asyncpg://eclume:eclume@127.0.0.1:55532/eclume")
REDIS_URL = os.environ.get("ECLUME_TEST_REDIS_URL", "redis://127.0.0.1:56479")
S3_ENDPOINT = os.environ.get("ECLUME_TEST_S3_ENDPOINT", "http://127.0.0.1:59100")
S3_ACCESS_KEY = os.environ.get("ECLUME_TEST_S3_ACCESS_KEY", "eclume")
S3_SECRET_KEY = os.environ.get("ECLUME_TEST_S3_SECRET_KEY", "eclume-test-secret")
REQUIRE_SERVICES = os.environ.get("ECLUME_TEST_REQUIRE_SERVICES") == "1"


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    """Roda uma corrotina num loop próprio (os testes são síncronos)."""
    return asyncio.run(coro)


def unreachable_services() -> list[str]:
    """Serviços de teste que não respondem na porta."""
    missing = []
    for name, url, port in (("postgres", DATABASE_URL, 5432), ("redis", REDIS_URL, 6379), ("minio", S3_ENDPOINT, 9000)):
        parts = urlsplit(url.replace("+asyncpg", ""))
        try:
            with socket.create_connection((parts.hostname or "127.0.0.1", parts.port or port), timeout=1):
                pass
        except OSError:
            missing.append(name)
    return missing


@dataclass(frozen=True)
class Services:
    """Recursos de teste desta sessão."""

    settings: Settings
    database: str

    def s3(self) -> Any:  # noqa: ANN401 — cliente boto3 sem stubs
        """Cliente S3 do MinIO de teste."""
        return boto3.client(
            "s3",
            endpoint_url=self.settings.s3_endpoint,
            aws_access_key_id=self.settings.s3_access_key,
            aws_secret_access_key=self.settings.s3_secret_key,
            region_name=self.settings.s3_region,
        )

    async def sql(self, fn: Callable[[Any], Awaitable[Any]]) -> Any:  # noqa: ANN401
        """Executa `fn(conn)` numa transação com o papel de conexão, num engine descartável."""
        engine = create_async_engine(self.settings.database_url)
        try:
            async with engine.begin() as conn:
                return await fn(conn)
        finally:
            await engine.dispose()


async def _admin(statement: str) -> None:
    admin = create_async_engine(DATABASE_URL, isolation_level="AUTOCOMMIT")
    try:
        async with admin.connect() as conn:
            await conn.execute(text(statement))
    finally:
        await admin.dispose()


def provision() -> Services:
    """Cria banco (com as migrations), bucket e escolhe o banco do Redis desta sessão."""
    suffix = secrets.token_hex(4)
    database = f"eclume_test_{suffix}"
    database_url = DATABASE_URL.rsplit("/", 1)[0] + f"/{database}"

    async def create_database() -> None:
        await _admin(f'CREATE DATABASE "{database}"')
        engine = create_async_engine(database_url)
        try:
            await migrate(engine)
        finally:
            await engine.dispose()

    run(create_database())
    settings = Settings(
        database_url=database_url,
        redis_url=f"{REDIS_URL.rstrip('/')}/{secrets.randbelow(15) + 1}",
        s3_endpoint=S3_ENDPOINT,
        s3_access_key=S3_ACCESS_KEY,
        s3_secret_key=S3_SECRET_KEY,
        s3_bucket=f"eclume-test-{suffix}",
        secret_key=secrets.token_hex(16),
        public_url="https://testserver",
    )
    services = Services(settings=settings, database=database)
    services.s3().create_bucket(Bucket=settings.s3_bucket)
    return services


def teardown(services: Services) -> None:
    """Apaga o banco e o bucket da sessão."""
    run(_admin(f'DROP DATABASE IF EXISTS "{services.database}" WITH (FORCE)'))
    s3 = services.s3()
    bucket = services.settings.s3_bucket
    for upload in s3.list_multipart_uploads(Bucket=bucket).get("Uploads", []):
        s3.abort_multipart_upload(Bucket=bucket, Key=upload["Key"], UploadId=upload["UploadId"])
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket):
        for obj in page.get("Contents", []):
            s3.delete_object(Bucket=bucket, Key=obj["Key"])
    s3.delete_bucket(Bucket=bucket)
