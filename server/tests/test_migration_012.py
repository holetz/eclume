"""Migration 012 (pipeline steps): the history of recordings that already existed."""

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
DONE, FAILED, MISMATCH, OPEN = uuid4(), uuid4(), uuid4(), uuid4()
TRANSCRIPT = uuid4()


def _recording(rec: Any) -> str:  # noqa: ANN401
    return f"""
INSERT INTO recordings (id, owner_id, title, status, source, recorded_at, size_bytes, content_type, content_hash,
                        audio_key)
VALUES ('{rec}', '{USER}', 'r', 'transcribed', 'upload', now(), 1, 'audio/ogg', 'sha256:{secrets.token_hex(32)}',
        'recordings/{rec}/audio');"""  # noqa: S608


SEED = f"""
INSERT INTO users (id, email, name, password_hash) VALUES ('{USER}', 'u@exemplo.com.br', 'U', 'h');
{_recording(DONE)}{_recording(FAILED)}{_recording(MISMATCH)}{_recording(OPEN)}
INSERT INTO transcription_jobs (owner_id, recording_id, revision, state, queued_at, started_at, finished_at,
                                error_code, error_message)
VALUES ('{USER}', '{DONE}', 1, 'succeeded', now() - interval '2 days', NULL, now() - interval '2 days', NULL, NULL),
       ('{USER}', '{DONE}', 2, 'succeeded', now() - interval '1 hour', now() - interval '59 minutes',
        now() - interval '58 minutes', NULL, NULL),
       ('{USER}', '{FAILED}', 1, 'failed', now(), NULL, now(), 'gpu_oom', 'CUDA out of memory'),
       ('{USER}', '{MISMATCH}', 1, 'failed', now(), NULL, now(), 'hash_mismatch', 'hash'),
       ('{USER}', '{OPEN}', 1, 'queued', now(), NULL, NULL, NULL, NULL);
INSERT INTO transcripts (id, owner_id, recording_id, revision, language, duration_ms)
VALUES ('{TRANSCRIPT}', '{USER}', '{DONE}', 2, 'pt', 1000);
INSERT INTO summaries (owner_id, transcript_id, transcript_revision, agenda_type_id, agenda_type_name, instructions,
                       version, status, trigger, provider_id, provider_name, provider_kind, model, content_md,
                       completed_at)
VALUES ('{USER}', '{TRANSCRIPT}', 2, gen_random_uuid(), 'Ata', 'x', 1, 'done', 'automatic', gen_random_uuid(), 'p',
        'claude-cli', 'm', '# Ata', now());
"""  # noqa: S608


@pytest.fixture(scope="module")
def url(services: Services) -> Iterator[str]:
    del services  # only for the test services check
    database = f"eclume_mig012_{secrets.token_hex(4)}"
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
            await migrate(engine, until="011_plataforma_de_processamento")
            async with engine.connect() as conn:
                await (await conn.get_raw_connection()).driver_connection.execute(SEED)
            assert await migrate(engine, until="012_etapas_do_pipeline") == ["012_etapas_do_pipeline"]
        finally:
            await engine.dispose()

    run(prepare())
    yield target
    run(admin(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)'))


def _steps(url: str, recording: Any) -> dict[tuple[int, str], tuple[Any, ...]]:  # noqa: ANN401
    async def go() -> list[Any]:
        engine = create_async_engine(url)
        try:
            async with engine.begin() as conn:
                sql = (
                    "SELECT revision, step, state, error_code, detail ->> 'reason', duration_ms"
                    " FROM pipeline_steps WHERE recording_id = :r"
                )
                return list((await conn.execute(text(sql), {"r": recording})).all())
        finally:
            await engine.dispose()

    return {(row[0], row[1]): tuple(row[2:]) for row in run(go())}


def test_transcribed_revisions_get_the_history(url: str):
    steps = _steps(url, DONE)
    assert steps[(2, "received")][0] == "done"
    assert steps[(2, "transcription")][:2] == ("done", None)
    assert steps[(2, "transcription")][3] == 60000
    for step in ("preprocessing", "fields", "agenda_type"):
        assert steps[(2, step)][:3] == ("skipped", None, "before_pipeline")
    # The automatic summary belongs to the last revision; on the previous one the step is skipped.
    assert steps[(2, "summary")][0] == "done"
    assert steps[(1, "summary")][:3] == ("skipped", None, "before_pipeline")


def test_failures_and_open_jobs(url: str):
    failed = _steps(url, FAILED)
    assert failed[(1, "transcription")][:2] == ("failed", "gpu_oom")
    assert (1, "fields") not in failed
    assert _steps(url, MISMATCH) == {(1, "received"): ("failed", "hash_mismatch", None, 0)}
    assert _steps(url, OPEN) == {(1, "received"): ("done", None, None, 0)}
