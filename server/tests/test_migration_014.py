"""Migration 014 (summary-centred recording): date source and versions renumbered per transcript."""

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
DESKTOP, WEB = uuid4(), uuid4()
TRANSCRIPT = uuid4()
TYPE_A, TYPE_B = uuid4(), uuid4()


def _recording(rec: Any, source: str) -> str:  # noqa: ANN401
    return f"""
INSERT INTO recordings (id, owner_id, title, status, source, recorded_at, size_bytes, content_type, content_hash,
                        audio_key)
VALUES ('{rec}', '{USER}', 'r', 'transcribed', '{source}', now(), 1, 'audio/ogg', 'sha256:{secrets.token_hex(32)}',
        'recordings/{rec}/audio');"""  # noqa: S608


def _summary(agenda_type: Any, version: int, minutes_ago: int) -> str:  # noqa: ANN401
    return f"""
INSERT INTO summaries (owner_id, transcript_id, transcript_revision, agenda_type_id, agenda_type_name, instructions,
                       version, status, trigger, provider_id, provider_name, provider_kind, model, content_md,
                       created_at, completed_at)
VALUES ('{USER}', '{TRANSCRIPT}', 1, '{agenda_type}', 'Tipo', 'x', {version}, 'done', 'manual', gen_random_uuid(),
        'p', 'claude-cli', 'm', '# v', now() - interval '{minutes_ago} minutes', now());"""  # noqa: S608


# Two types with the old numbering (per type): A1, B1, A2, B2 in creation order.
SEED = f"""
INSERT INTO users (id, email, name, password_hash) VALUES ('{USER}', 'u@exemplo.com.br', 'U', 'h');
{_recording(DESKTOP, "desktop")}{_recording(WEB, "upload")}
INSERT INTO transcripts (id, owner_id, recording_id, revision, language, duration_ms)
VALUES ('{TRANSCRIPT}', '{USER}', '{DESKTOP}', 1, 'pt', 1000);
{_summary(TYPE_A, 1, 40)}{_summary(TYPE_B, 1, 30)}{_summary(TYPE_A, 2, 20)}{_summary(TYPE_B, 2, 10)}
"""  # noqa: S608


@pytest.fixture(scope="module")
def url(services: Services) -> Iterator[str]:
    del services  # only for the test services check
    database = f"eclume_mig014_{secrets.token_hex(4)}"
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
            await migrate(engine, until="013_revisao_do_processamento")
            async with engine.connect() as conn:
                await (await conn.get_raw_connection()).driver_connection.execute(SEED)
            assert await migrate(engine, until="014_gravacao_resumo") == ["014_gravacao_resumo"]
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


def test_date_source_from_the_source(url: str):
    rows = dict(_rows(url, "SELECT id, recorded_at_source FROM recordings"))
    assert rows == {DESKTOP: "capture", WEB: "upload"}
    assert {kind for (kind,) in _rows(url, "SELECT kind FROM recordings")} == {"meeting"}


def test_versions_renumbered_per_transcript_in_creation_order(url: str):
    rows = _rows(url, "SELECT agenda_type_id, version, origin FROM summaries ORDER BY created_at")
    assert rows == [
        (TYPE_A, 1, "generated"),
        (TYPE_B, 2, "generated"),
        (TYPE_A, 3, "generated"),
        (TYPE_B, 4, "generated"),
    ]
