"""Service harness of the server suite: real Postgres, Redis and MinIO.

The services come from `deploy/docker-compose.test.yml`. Each test session creates its own database
and bucket and picks its own Redis database, and undoes everything at the end. The migrations run as
the superuser (the migrator); the suite connects as `eclume_server`, the production connection role.
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
import redis
from sqlalchemy import make_url, text
from sqlalchemy.ext.asyncio import create_async_engine

from eclume_server.config import Settings
from eclume_server.db.migrate import RUNTIME_ROLE, enable_runtime_login, migrate

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Coroutine

DATABASE_URL = os.environ.get("ECLUME_TEST_DATABASE_URL", "postgresql+asyncpg://eclume:eclume@127.0.0.1:55532/eclume")
REDIS_URL = os.environ.get("ECLUME_TEST_REDIS_URL", "redis://127.0.0.1:56479")
S3_ENDPOINT = os.environ.get("ECLUME_TEST_S3_ENDPOINT", "http://127.0.0.1:59100")
S3_ACCESS_KEY = os.environ.get("ECLUME_TEST_S3_ACCESS_KEY", "eclume")
S3_SECRET_KEY = os.environ.get("ECLUME_TEST_S3_SECRET_KEY", "eclume-test-secret")
REQUIRE_SERVICES = os.environ.get("ECLUME_TEST_REQUIRE_SERVICES") == "1"
RUNTIME_PASSWORD = "eclume-test-runtime"  # test password of the connection role


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    """Runs a coroutine in its own loop (the tests are synchronous)."""
    return asyncio.run(coro)


def unreachable_services() -> list[str]:
    """Test services that do not answer on their port."""
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
    """Test resources of this session."""

    settings: Settings
    database: str

    def s3(self) -> Any:  # noqa: ANN401 — boto3 client without stubs
        """S3 client of the test MinIO."""
        return boto3.client(
            "s3",
            endpoint_url=self.settings.s3_endpoint,
            aws_access_key_id=self.settings.s3_access_key,
            aws_secret_access_key=self.settings.s3_secret_key,
            region_name=self.settings.s3_region,
        )

    async def sql(self, fn: Callable[[Any], Awaitable[Any]]) -> Any:  # noqa: ANN401
        """Runs `fn(conn)` in a transaction with the connection role, on a throwaway engine."""
        engine = create_async_engine(self.settings.database_url)
        try:
            async with engine.begin() as conn:
                return await fn(conn)
        finally:
            await engine.dispose()


async def while_recording_locked(
    services: Services,
    recording_id: str,
    request: Callable[[], Any],
    then: str,
    **params: str,
) -> Any:  # noqa: ANN401
    """Two simultaneous requests: the second (`request`) arrives with the recording locked by the first.

    Holds the recording row, fires `request` in a thread, waits for it to wait on that lock, runs
    `then` (what the first would do), commits and returns the response of `request`.
    """
    engine = create_async_engine(services.settings.database_url)
    watcher = engine.execution_options(isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as holder, watcher.connect() as watch:
            await holder.execute(text("SELECT 1 FROM recordings WHERE id = :id FOR UPDATE"), {"id": recording_id})
            pid = (await holder.execute(text("SELECT pg_backend_pid()"))).scalar()
            pending = asyncio.ensure_future(asyncio.to_thread(request))
            blocked = text(
                "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' "
                "AND CAST(:pid AS int) = ANY(pg_blocking_pids(pid))"
            )
            for _ in range(200):
                if (await watch.execute(blocked, {"pid": pid})).scalar():
                    break
                await asyncio.sleep(0.05)
            else:
                await holder.rollback()
                await pending
                msg = "the second request did not wait for the recording lock"
                raise AssertionError(msg)
            await holder.execute(text(then), params)
            await holder.commit()
            return await pending
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
    """Creates the database (with the migrations) and the bucket, and picks the Redis database of this session."""
    suffix = secrets.token_hex(4)
    database = f"eclume_test_{suffix}"
    owner_url = DATABASE_URL.rsplit("/", 1)[0] + f"/{database}"
    runtime_url = (
        make_url(owner_url).set(username=RUNTIME_ROLE, password=RUNTIME_PASSWORD).render_as_string(hide_password=False)
    )

    async def create_database() -> None:
        await _admin(f'CREATE DATABASE "{database}"')
        engine = create_async_engine(owner_url)
        try:
            await migrate(engine)
            await enable_runtime_login(engine, RUNTIME_PASSWORD)
        finally:
            await engine.dispose()

    run(create_database())
    settings = Settings(
        database_url=runtime_url,
        redis_url=f"{REDIS_URL.rstrip('/')}/{secrets.randbelow(15) + 1}",
        s3_endpoint=S3_ENDPOINT,
        s3_access_key=S3_ACCESS_KEY,
        s3_secret_key=S3_SECRET_KEY,
        s3_bucket=f"eclume-test-{suffix}",
        secret_key=secrets.token_hex(16),
        public_url="https://testserver",
        # All tests come in through the same IP (`testclient`); the limit is proved with an app of its own.
        credential_attempts_per_minute=100_000,
        signups_per_ip_per_day=100_000,
        # Parts at the contract minimum (5 MiB) make the upload tests lighter.
        upload_part_size=5 * 1024 * 1024,
    )
    services = Services(settings=settings, database=database)
    services.s3().create_bucket(Bucket=settings.s3_bucket)
    # Queues of an earlier session in the same Redis database would hang the workers in burst mode.
    redis.Redis.from_url(settings.redis_url).flushdb()
    return services


def teardown(services: Services) -> None:
    """Drops the database and the bucket of the session."""
    run(_admin(f'DROP DATABASE IF EXISTS "{services.database}" WITH (FORCE)'))
    redis.Redis.from_url(services.settings.redis_url).flushdb()
    s3 = services.s3()
    bucket = services.settings.s3_bucket
    for upload in s3.list_multipart_uploads(Bucket=bucket).get("Uploads", []):
        s3.abort_multipart_upload(Bucket=bucket, Key=upload["Key"], UploadId=upload["UploadId"])
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket):
        for obj in page.get("Contents", []):
            s3.delete_object(Bucket=bucket, Key=obj["Key"])
    s3.delete_bucket(Bucket=bucket)
