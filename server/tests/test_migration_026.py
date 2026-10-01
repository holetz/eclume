"""Migration 026 (cotas e fila justa): padrões das cotas e jobs em aberto já despachados."""

from __future__ import annotations

import secrets
from typing import TYPE_CHECKING, Any
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from eclume_server.db.migrate import migrate
from eclume_server_testing.harness import DATABASE_URL, run

if TYPE_CHECKING:
    from collections.abc import Iterator

    from eclume_server_testing.harness import Services

USER = uuid4()
QUEUED, RUNNING, DONE = uuid4(), uuid4(), uuid4()


def _recording_and_job(rec: Any, state: str) -> str:  # noqa: ANN401
    finished = "now()" if state == "succeeded" else "NULL"
    return f"""
INSERT INTO recordings (id, owner_id, title, status, source, recorded_at, size_bytes, content_type, content_hash,
                        audio_key)
VALUES ('{rec}', '{USER}', 'r', 'queued', 'upload', now(), 1, 'audio/ogg', 'sha256:{secrets.token_hex(32)}',
        'recordings/{rec}/audio');
INSERT INTO transcription_jobs (owner_id, recording_id, revision, state, queued_at, finished_at)
VALUES ('{USER}', '{rec}', 1, '{state}', now() - interval '1 hour', {finished});"""  # noqa: S608


SEED = f"""
INSERT INTO users (id, email, name, password_hash) VALUES ('{USER}', 'u@exemplo.com.br', 'U', 'h');
{_recording_and_job(QUEUED, "queued")}{_recording_and_job(RUNNING, "running")}{_recording_and_job(DONE, "succeeded")}
"""  # noqa: S608


@pytest.fixture(scope="module")
def url(services: Services) -> Iterator[str]:
    del services  # só pela checagem dos serviços de teste
    database = f"eclume_mig026_{secrets.token_hex(4)}"
    target = DATABASE_URL.rsplit("/", 1)[0] + f"/{database}"

    async def admin(statement: str) -> None:
        engine = create_async_engine(DATABASE_URL, isolation_level="AUTOCOMMIT")
        try:
            async with engine.connect() as conn:
                await conn.execute(text(statement))
        finally:
            await engine.dispose()

    async def prepare() -> None:
        await admin(f'CREATE DATABASE "{database}"')
        engine = create_async_engine(target)
        try:
            await migrate(engine, until="025_validade_da_chave")
            async with engine.connect() as conn:
                await (await conn.get_raw_connection()).driver_connection.execute(SEED)
            assert await migrate(engine, until="026_cotas_e_fila_justa") == ["026_cotas_e_fila_justa"]
        finally:
            await engine.dispose()

    run(prepare())
    yield target
    run(admin(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)'))


def _rows(url: str, sql: str) -> list[tuple[Any, ...]]:
    async def go() -> list[Any]:
        engine = create_async_engine(url)
        try:
            async with engine.begin() as conn:
                return [tuple(row) for row in (await conn.execute(text(sql))).all()]
        finally:
            await engine.dispose()

    return run(go())


def test_cotas_padrao_da_plataforma(url: str):
    [(quotas,)] = _rows(url, "SELECT quotas FROM platform_settings")
    assert quotas == {
        "storage_bytes": 10 * 1024**3,
        "file_bytes": 2 * 1024**3,
        "open_uploads": 3,
        "gpu_minutes_24h": 600,
        "agent_requests_24h": 200,
    }


def test_conta_nasce_sem_sobreposicao(url: str):
    assert _rows(url, "SELECT quotas FROM users") == [(None,)]


def test_jobs_em_aberto_nascem_despachados(url: str):
    rows = dict(_rows(url, "SELECT recording_id, dispatched_at = queued_at FROM transcription_jobs"))
    assert rows == {QUEUED: True, RUNNING: True, DONE: None}
