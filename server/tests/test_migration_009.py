"""Migration 009 (tipos de agenda) sobre dados no formato da 008.

Aplica 001 a 008 num banco próprio, semeia duas contas com os templates que a 008 deixa (os três
padrões semeados e um pessoal com nome de tipo padrão), uma gravação transcrita com resumo que cita
um template, aplica a 009 e confere a conversão, os tipos padrão do admin, as FKs compostas e a
remoção dos templates.
"""

from __future__ import annotations

import secrets
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine

from eclume_server.db.migrate import migrate
from eclume_server_testing.harness import DATABASE_URL, run

if TYPE_CHECKING:
    from collections.abc import Iterator

    from eclume_server_testing.harness import Services

BEFORE = "008_conta_por_usuario"
DEFAULT_TYPES = ["Reunião de equipe", "1:1", "Conversa com cliente", "Nota de voz"]
SEEDED = ["Ata de reunião", "Resumo executivo", "Decisões e ações"]

ANA, BRUNO = uuid4(), uuid4()
REC, TR = uuid4(), uuid4()
PERSONAL = uuid4()

SEED = f"""
INSERT INTO users (id, email, name, password_hash, created_at) VALUES
    ('{ANA}', 'ana@exemplo.com.br', 'Ana', 'hash-ana', '2026-09-01T01:00:00Z'),
    ('{BRUNO}', 'bruno@exemplo.com.br', 'Bruno', 'hash-bruno', '2026-09-01T02:00:00Z');
SELECT eclume_seed_summary_templates('{ANA}');
SELECT eclume_seed_summary_templates('{BRUNO}');
INSERT INTO summary_templates (id, owner_id, name, description, instructions, is_default, created_at)
VALUES ('{PERSONAL}', '{BRUNO}', '1:1', 'Minhas conversas individuais.', 'Liste os combinados.', false,
        now() + interval '1 hour');

INSERT INTO recordings (id, owner_id, title, status, source, recorded_at, size_bytes, content_type, content_hash,
                        audio_key)
VALUES ('{REC}', '{ANA}', 'Reunião da Ana', 'transcribed', 'upload', now(), 100, 'audio/ogg',
        'sha256:{secrets.token_hex(32)}', 'recordings/{REC}/audio');
INSERT INTO transcription_jobs (owner_id, recording_id, revision, state) VALUES ('{ANA}', '{REC}', 1, 'succeeded');
INSERT INTO transcripts (id, owner_id, recording_id, revision, language, duration_ms)
VALUES ('{TR}', '{ANA}', '{REC}', 1, 'pt', 60000);
INSERT INTO speakers (transcript_id, owner_id, speaker_id, position, label, talk_ms)
VALUES ('{TR}', '{ANA}', 'S1', 1, 'Locutor 1', 60000);
INSERT INTO segments (transcript_id, owner_id, segment_id, position, speaker_id, start_ms, end_ms, text)
VALUES ('{TR}', '{ANA}', 'g1', 1, 'S1', 0, 60000, 'próximos passos');
INSERT INTO summaries (owner_id, transcript_id, transcript_revision, template_id, template_name, instructions,
                       version, status, trigger, provider_id, provider_name, provider_kind, model, content_md)
SELECT '{ANA}', '{TR}', 1, id, name, instructions, 1, 'done', 'automatic', gen_random_uuid(), 'claude',
       'claude-cli', 'sonnet', '# Ata'
FROM summary_templates WHERE owner_id = '{ANA}' AND is_default;
"""  # noqa: S608 — valores fixos do teste


async def _rows(conn: Any, sql: str, **params: Any) -> list[Any]:  # noqa: ANN401
    return list((await conn.execute(text(sql), params)).all())


@pytest.fixture(scope="module")
def migrated(services: Services) -> Iterator[dict[str, Any]]:
    """Banco próprio: 001 a 008, a semeadura no formato da 008, o retrato de antes e a 009."""
    del services  # só pela checagem dos serviços de teste
    database = f"eclume_mig009_{secrets.token_hex(4)}"
    url = DATABASE_URL.rsplit("/", 1)[0] + f"/{database}"

    async def admin(statement: str) -> None:
        engine = create_async_engine(DATABASE_URL, isolation_level="AUTOCOMMIT")
        try:
            async with engine.connect() as conn:
                await conn.execute(text(statement))
        finally:
            await engine.dispose()

    async def prepare() -> dict[str, Any]:
        await admin(f'CREATE DATABASE "{database}"')
        engine = create_async_engine(url)
        try:
            assert (await migrate(engine, until=BEFORE))[-1] == BEFORE
            async with engine.connect() as conn:
                raw = (await conn.get_raw_connection()).driver_connection
                await raw.execute(SEED)
            async with engine.begin() as conn:
                templates = await _rows(
                    conn, "SELECT id, owner_id, name, description, instructions FROM summary_templates"
                )
                summary = (await _rows(conn, "SELECT template_id, template_name FROM summaries"))[0]
            assert await migrate(engine, until="009_tipos_de_agenda") == ["009_tipos_de_agenda"]
            return {"templates": templates, "summary": tuple(summary)}
        finally:
            await engine.dispose()

    before = run(prepare())
    yield {"before": before, "url": url}
    run(admin(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)'))


def _query(migrated: dict[str, Any], *statements: str, **params: Any) -> list[Any]:  # noqa: ANN401
    """Roda os comandos numa transação; devolve as linhas do último."""

    async def go() -> list[Any]:
        engine = create_async_engine(migrated["url"])
        try:
            async with engine.begin() as conn:
                for sql in statements[:-1]:
                    await conn.execute(text(sql), params)
                return await _rows(conn, statements[-1], **params)
        finally:
            await engine.dispose()

    return run(go())


def _names(migrated: dict[str, Any], owner: UUID) -> list[str]:
    rows = _query(
        migrated, "SELECT name FROM agenda_types WHERE owner_id = :o ORDER BY position, created_at, id", o=owner
    )
    return [row[0] for row in rows]


def test_cada_template_vira_tipo_do_dono_com_o_mesmo_id(migrated: dict[str, Any]) -> None:
    for template_id, owner, name, description, instructions in migrated["before"]["templates"]:
        row = _query(
            migrated,
            "SELECT owner_id, name, identify, summary_instructions, title_pattern, default_tags, from_default_id"
            " FROM agenda_types WHERE id = :id",
            id=template_id,
        )
        assert row == [(owner, name, description or "", instructions, None, [], None)]


def test_os_resumos_citam_o_tipo_convertido(migrated: dict[str, Any]) -> None:
    summary = _query(migrated, "SELECT agenda_type_id, agenda_type_name FROM summaries")
    assert [tuple(row) for row in summary] == [migrated["before"]["summary"]]
    (type_name,) = _query(migrated, "SELECT name FROM agenda_types WHERE id = :id", id=summary[0][0])[0]
    assert type_name == "Ata de reunião"


def test_os_tipos_padrao_do_admin_chegam_a_toda_conta(migrated: dict[str, Any]) -> None:
    defaults = _query(
        migrated,
        "SELECT name, title_pattern, default_tags, include_for_new_users FROM default_agenda_types ORDER BY position",
    )
    assert [row[0] for row in defaults] == DEFAULT_TYPES
    assert tuple(defaults[0][1:]) == ("Reunião de equipe · {assunto}", ["interno", "planejamento"], True)
    assert _names(migrated, ANA) == SEEDED + DEFAULT_TYPES
    # O nome já usado por um template pessoal ganha o sufixo.
    assert _names(migrated, BRUNO) == [*SEEDED, "1:1", "Reunião de equipe", "1:1 (padrão)", *DEFAULT_TYPES[2:]]
    copied = _query(
        migrated,
        "SELECT count(*) FROM agenda_types a JOIN default_agenda_types d ON d.id = a.from_default_id"
        " WHERE a.identify = d.identify AND a.summary_instructions = d.summary_instructions",
    )
    assert copied == [(2 * len(DEFAULT_TYPES),)]


def test_gravacoes_ficam_sem_tipo(migrated: dict[str, Any]) -> None:
    assert _query(migrated, "SELECT agenda_type_id, agenda_type_origin FROM recordings") == [(None, None)]


def test_saem_os_templates(migrated: dict[str, Any]) -> None:
    assert _query(migrated, "SELECT to_regclass('summary_templates')") == [(None,)]
    functions = {row[0] for row in _query(migrated, "SELECT proname FROM pg_proc WHERE proname LIKE 'eclume_seed%'")}
    assert functions == {"eclume_seed_user_defaults"}


def test_a_semeadura_de_conta_nova_e_idempotente(migrated: dict[str, Any]) -> None:
    carla = uuid4()
    _query(
        migrated,
        "INSERT INTO users (id, email, name, password_hash) VALUES (:u, 'carla@exemplo.com.br', 'Carla', 'h')",
        "UPDATE default_agenda_types SET include_for_new_users = false WHERE name = 'Nota de voz'",
        "SELECT eclume_seed_user_defaults(:u)",
        "SELECT eclume_seed_user_defaults(:u)",
        u=carla,
    )
    assert _names(migrated, carla) == DEFAULT_TYPES[:3]


def test_filho_de_outra_conta_e_recusado_pelas_fks_compostas(migrated: dict[str, Any]) -> None:
    with pytest.raises(DBAPIError, match="foreign key"):
        _query(migrated, "UPDATE segments SET owner_id = :o WHERE transcript_id = :t", o=BRUNO, t=TR)
    bruno_type = _query(migrated, "SELECT id FROM agenda_types WHERE owner_id = :o LIMIT 1", o=BRUNO)[0][0]
    with pytest.raises(DBAPIError, match="foreign key"):
        _query(migrated, "UPDATE recordings SET agenda_type_id = :a WHERE id = :r", a=bruno_type, r=REC)


def test_sob_eclume_app_cada_um_so_ve_os_proprios_tipos(migrated: dict[str, Any]) -> None:
    async def go() -> tuple[int, int]:
        engine = create_async_engine(migrated["url"])
        try:
            async with engine.begin() as conn:
                await conn.execute(text("SET LOCAL ROLE eclume_app"))
                await conn.execute(text("SELECT set_config('app.user_id', :u, true)"), {"u": str(ANA)})
                mine = (await conn.execute(text("SELECT count(*) FROM agenda_types"))).scalar_one()
                others = (
                    await conn.execute(text("SELECT count(*) FROM agenda_types WHERE owner_id <> :u"), {"u": ANA})
                ).scalar_one()
                return mine, others
        finally:
            await engine.dispose()

    assert run(go()) == (len(SEEDED) + len(DEFAULT_TYPES), 0)
    with pytest.raises(DBAPIError, match="permission denied"):
        _query(migrated, "SET LOCAL ROLE eclume_app", "SELECT * FROM default_agenda_types")
