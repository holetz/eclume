"""Migration 008 (conta por usuário) sobre dados no formato da 007.

Aplica 001 a 007 num banco próprio, semeia três organizações como a 007 as guardava (admins e
membros, pessoas usadas por mais de um usuário, amostras, sugestões, templates da organização,
compartilhamento, grupo, convite, consentimento, auditoria, segredo e configuração), aplica a 008
e confere o que a spec holetz/eclume#32 promete preservar e o que ela remove.
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

BEFORE = "007_purga_de_embeddings"

ORG_A, ORG_B, ORG_C = uuid4(), uuid4(), uuid4()
ADMIN_A, MEMBER_A1, MEMBER_A2 = uuid4(), uuid4(), uuid4()
ADMIN_B, MEMBER_B = uuid4(), uuid4()
LONE_C = uuid4()
REC_1, REC_2, REC_3 = uuid4(), uuid4(), uuid4()
TR_1, TR_2, TR_3 = uuid4(), uuid4(), uuid4()
PERSON_1, PERSON_2, PERSON_3 = uuid4(), uuid4(), uuid4()
GROUP = uuid4()
PROVIDER = uuid4()
PERSONAL_TEMPLATE = uuid4()

CONTENT_TABLES = (
    "recordings",
    "uploads",
    "collections",
    "summary_templates",
    "people",
    "transcription_jobs",
    "transcripts",
    "speakers",
    "segments",
    "speaker_embeddings",
    "summaries",
    "voice_samples",
    "speaker_suggestions",
)


def _settings(threshold: float) -> str:
    return (
        '\'{"engine": "whisperx-local", "model": "large-v3-turbo", "compute_type": "int8_float16",'
        ' "batch_size": null, "default_language": "pt", "fallback_model": "medium", "endpoint_url": null}\','
        ' \'{"enabled": true, "model": "pyannote/speaker-diarization-community-1",'
        ' "min_speakers": null, "max_speakers": null}\','
        f' \'{{"default_provider_id": "{PROVIDER}", "auto_summarize": true, "default_template_id": null}}\','
        f' \'{{"enabled": true, "suggestion_threshold": {threshold},'
        ' "consent_term_version": "2", "consent_term_text": "Autorizo."}\''
    )


def _recording(rec: UUID, org: UUID, owner: UUID, transcript: UUID, title: str) -> str:
    return f"""
INSERT INTO recordings (id, org_id, owner_id, title, status, source, recorded_at, size_bytes, content_type,
                        content_hash, audio_key)
VALUES ('{rec}', '{org}', '{owner}', '{title}', 'transcribed', 'upload', now(), 100, 'audio/ogg',
        'sha256:{secrets.token_hex(32)}', 'orgs/{org}/users/{owner}/recordings/{rec}/audio');
INSERT INTO transcription_jobs (org_id, recording_id, revision, state) VALUES ('{org}', '{rec}', 1, 'succeeded');
INSERT INTO transcripts (id, org_id, recording_id, revision, language, duration_ms, updated_at)
VALUES ('{transcript}', '{org}', '{rec}', 1, 'pt', 60000, '2026-09-20T10:00:00Z');
INSERT INTO speakers (transcript_id, org_id, speaker_id, position, label, talk_ms)
VALUES ('{transcript}', '{org}', 'S1', 1, 'Locutor 1', 30000), ('{transcript}', '{org}', 'S2', 2, 'Locutor 2', 30000);
INSERT INTO segments (transcript_id, org_id, segment_id, position, speaker_id, start_ms, end_ms, text)
VALUES ('{transcript}', '{org}', 'g1', 1, 'S1', 0, 30000, 'turmas de liderança'),
       ('{transcript}', '{org}', 'g2', 2, 'S2', 30000, 60000, 'próximos passos');
INSERT INTO speaker_embeddings (transcript_id, org_id, speaker_id, model, embedding)
VALUES ('{transcript}', '{org}', 'S1', 'm', '[0.1, 0.2, 0.3]'), ('{transcript}', '{org}', 'S2', 'm', '[0.3, 0.2, 0.1]');
INSERT INTO summaries (org_id, transcript_id, transcript_revision, template_id, template_name, instructions, version,
                       status, trigger, provider_id, provider_name, provider_kind, model, content_md, created_by)
VALUES ('{org}', '{transcript}', 1, gen_random_uuid(), 'Ata de reunião', 'x', 1, 'done', 'automatic',
        '{PROVIDER}', 'claude', 'claude-cli', 'sonnet', '# Ata', '{owner}');
"""  # noqa: S608 — valores fixos do teste


SEED = f"""
INSERT INTO organizations (id, name, created_at) VALUES
    ('{ORG_A}', 'EK Consultoria', '2026-09-01T00:00:00Z'),
    ('{ORG_B}', 'Outra', '2026-09-02T00:00:00Z'),
    ('{ORG_C}', 'Sem templates', '2026-09-03T00:00:00Z');
INSERT INTO users (id, org_id, email, name, password_hash, role, created_at) VALUES
    ('{ADMIN_A}', '{ORG_A}', 'admin.a@example.com', 'Admin A', 'hash-admin-a', 'admin', '2026-09-01T01:00:00Z'),
    ('{MEMBER_A1}', '{ORG_A}', 'membro.a1@example.com', 'Membro A1', 'hash-a1', 'member', '2026-09-01T02:00:00Z'),
    ('{MEMBER_A2}', '{ORG_A}', 'membro.a2@example.com', 'Membro A2', 'hash-a2', 'member', '2026-09-01T03:00:00Z'),
    ('{ADMIN_B}', '{ORG_B}', 'admin.b@example.net', 'Admin B', 'hash-admin-b', 'admin', '2026-09-02T01:00:00Z'),
    ('{MEMBER_B}', '{ORG_B}', 'membro.b@example.net', 'Membro B', 'hash-b', 'member', '2026-09-02T02:00:00Z'),
    ('{LONE_C}', '{ORG_C}', 'sozinho@c.test', 'Sozinho C', 'hash-c', 'member', '2026-09-03T01:00:00Z');
INSERT INTO sessions (token_hash, csrf_token, user_id, expires_at)
VALUES ('sessao-admin-a', 'csrf', '{ADMIN_A}', now() + interval '1 day');
INSERT INTO api_tokens (org_id, user_id, name, token_hash, prefix, scopes)
VALUES ('{ORG_A}', '{MEMBER_A1}', 'lumea', 'pat-a1', 'eclp_a1', '{{transcripts:read}}');

INSERT INTO org_settings (org_id, asr, diarization, summarization, voice_identification, updated_by)
VALUES ('{ORG_A}', {_settings(0.61)}, '{ADMIN_A}'), ('{ORG_B}', {_settings(0.7)}, '{ADMIN_B}');
INSERT INTO agent_providers (id, org_id, name, kind, model, api_key_encrypted)
VALUES ('{PROVIDER}', '{ORG_A}', 'claude', 'claude-cli', 'sonnet', 'cifrado-provider');
SELECT eclume_seed_summary_templates('{ORG_A}');
SELECT eclume_seed_summary_templates('{ORG_B}');
INSERT INTO summary_templates (id, org_id, owner_id, name, instructions, is_default)
VALUES ('{PERSONAL_TEMPLATE}', '{ORG_A}', '{MEMBER_A1}', 'Pessoal', 'x', true);
INSERT INTO org_secrets (org_id, name, value_encrypted, updated_by)
VALUES ('{ORG_A}', 'hf_token', 'cifrado-hf-a', '{ADMIN_A}'), ('{ORG_B}', 'hf_token', 'cifrado-hf-b', '{ADMIN_B}');

INSERT INTO people (id, org_id, name, email, voice_consent_status, voice_consent_updated_at,
                    voice_consent_term_version, voice_consent_by, created_by)
VALUES ('{PERSON_1}', '{ORG_A}', 'Rafael Lima', 'rafael@example.com', 'granted', now(), '2',
        '{ADMIN_A}', '{ADMIN_A}'),
       ('{PERSON_2}', '{ORG_A}', 'Juliana Prado', 'juliana@example.com', 'none', NULL, NULL, NULL, NULL),
       ('{PERSON_3}', '{ORG_B}', 'Pessoa B', NULL, 'none', NULL, NULL, NULL, '{MEMBER_B}');
INSERT INTO voice_consents (org_id, person_id, status, term_version, term_text, recorded_by)
VALUES ('{ORG_A}', '{PERSON_1}', 'granted', '2', 'Autorizo.', '{ADMIN_A}');

{_recording(REC_1, ORG_A, ADMIN_A, TR_1, "Reunião do admin")}
{_recording(REC_2, ORG_A, MEMBER_A1, TR_2, "Reunião do membro")}
{_recording(REC_3, ORG_B, MEMBER_B, TR_3, "Reunião da outra")}

UPDATE speakers SET person_id = '{PERSON_1}' WHERE transcript_id IN ('{TR_1}', '{TR_2}') AND speaker_id = 'S1';
UPDATE speakers SET person_id = '{PERSON_3}' WHERE transcript_id = '{TR_3}' AND speaker_id = 'S1';
INSERT INTO voice_samples (transcript_id, speaker_id, org_id, person_id, model, embedding, talk_ms, created_by)
VALUES ('{TR_1}', 'S1', '{ORG_A}', '{PERSON_1}', 'm', '[0.1, 0.2, 0.3]', 30000, '{ADMIN_A}'),
       ('{TR_2}', 'S1', '{ORG_A}', '{PERSON_1}', 'm', '[0.1, 0.2, 0.3]', 30000, '{MEMBER_A1}');
INSERT INTO speaker_suggestions (transcript_id, speaker_id, org_id, person_id, score)
VALUES ('{TR_2}', 'S2', '{ORG_A}', '{PERSON_2}', 0.8);

INSERT INTO groups (id, org_id, name) VALUES ('{GROUP}', '{ORG_A}', 'Consultores');
INSERT INTO group_members (group_id, user_id, org_id) VALUES ('{GROUP}', '{MEMBER_A2}', '{ORG_A}');
INSERT INTO recording_shares (org_id, recording_id, target_type, group_id, created_by)
VALUES ('{ORG_A}', '{REC_1}', 'group', '{GROUP}', '{ADMIN_A}'),
       ('{ORG_A}', '{REC_2}', 'organization', NULL, '{MEMBER_A1}');
INSERT INTO invitations (org_id, email, token_hash, expires_at, created_by)
VALUES ('{ORG_A}', 'novo@example.com', 'convite', now() + interval '7 days', '{ADMIN_A}');
INSERT INTO voice_audit (org_id, person_id, event) VALUES ('{ORG_A}', '{PERSON_1}', 'consent_granted');
INSERT INTO collections (org_id, owner_id, name) VALUES ('{ORG_A}', '{MEMBER_A1}', 'Cliente X');
INSERT INTO uploads (org_id, owner_id, status, filename, content_type, size_bytes, sha256, part_size, part_count,
                     new_recording_id, expires_at)
VALUES ('{ORG_A}', '{MEMBER_A2}', 'in_progress', 'a.ogg', 'audio/ogg', 10, '{"0" * 64}', 5242880, 1,
        gen_random_uuid(), now() + interval '1 day');
"""  # noqa: S608 — valores fixos do teste


async def _rows(conn: Any, sql: str, **params: Any) -> list[Any]:  # noqa: ANN401
    return list((await conn.execute(text(sql), params)).all())


@pytest.fixture(scope="module")
def migrated(services: Services) -> Iterator[dict[str, Any]]:
    """Banco próprio: 001 a 007, a semeadura no formato da 007, o retrato de antes e a 008."""
    del services  # só pela checagem dos serviços de teste
    database = f"eclume_mig008_{secrets.token_hex(4)}"
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
                before = {
                    table: {row[0] for row in await _rows(conn, f"SELECT id FROM {table}")}  # noqa: S608
                    for table in ("users", "recordings", "transcripts", "summaries", "people")
                }
                before["segments"] = len(await _rows(conn, "SELECT 1 FROM segments"))
                before["audio_keys"] = dict(await _rows(conn, "SELECT id, audio_key FROM recordings"))
                before["updated_at"] = dict(await _rows(conn, "SELECT id, updated_at FROM transcripts"))
                before["hashes"] = dict(
                    await _rows(conn, "SELECT email, password_hash FROM users WHERE role = 'admin'")
                )
                before["org_a_templates"] = {
                    row[0]: row[1]
                    for row in await _rows(
                        conn,
                        "SELECT id, name FROM summary_templates WHERE org_id = :org AND owner_id IS NULL",
                        org=ORG_A,
                    )
                }
                before["org_a_default"] = (
                    await conn.execute(
                        text("SELECT summarization->>'default_template_id' FROM org_settings WHERE org_id = :org"),
                        {"org": ORG_A},
                    )
                ).scalar_one()
            assert await migrate(engine, until="008_conta_por_usuario") == ["008_conta_por_usuario"]
            return before
        finally:
            await engine.dispose()

    before = run(prepare())
    yield {"before": before, "url": url}
    run(admin(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)'))


def _query(migrated: dict[str, Any], sql: str, **params: Any) -> list[Any]:  # noqa: ANN401
    async def go() -> list[Any]:
        engine = create_async_engine(migrated["url"])
        try:
            async with engine.begin() as conn:
                return await _rows(conn, sql, **params)
        finally:
            await engine.dispose()

    return run(go())


def _as_user(migrated: dict[str, Any], user: UUID, sql: str) -> list[Any]:
    """Consulta sob `eclume_app`, com a RLS do usuário."""

    async def go() -> list[Any]:
        engine = create_async_engine(migrated["url"])
        try:
            async with engine.begin() as conn:
                await conn.execute(text("SET LOCAL ROLE eclume_app"))
                await conn.execute(text("SELECT set_config('app.user_id', :user, true)"), {"user": str(user)})
                return await _rows(conn, sql)
        finally:
            await engine.dispose()

    return run(go())


def test_saem_as_tabelas_colunas_e_funcoes_da_organizacao(migrated: dict[str, Any]) -> None:
    gone = (
        "organizations",
        "groups",
        "group_members",
        "recording_shares",
        "invitations",
        "voice_consents",
        "voice_audit",
        "org_settings",
        "org_secrets",
    )
    for table in gone:
        assert _query(migrated, "SELECT to_regclass(:t)", t=table) == [(None,)], table
    columns = _query(
        migrated,
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'"
        " AND (column_name = 'org_id' OR (table_name = 'users' AND column_name = 'role')"
        " OR (table_name = 'people' AND column_name LIKE 'voice_consent%'))",
    )
    assert columns == []
    functions = _query(
        migrated,
        "SELECT proname FROM pg_proc WHERE proname = ANY(:names)",
        names=[
            "eclume_org",
            "eclume_admin",
            "eclume_actor",
            "eclume_voice_forget",
            "eclume_purge_speaker_embeddings",
            "eclume_voice_sample_removed",
        ],
    )
    assert functions == []


def test_cada_admin_vira_conta_de_admin_com_o_mesmo_hash(migrated: dict[str, Any]) -> None:
    admins = dict(_query(migrated, "SELECT email, password_hash FROM admins"))
    assert admins == migrated["before"]["hashes"]
    assert set(admins) == {"admin.a@example.com", "admin.b@example.net"}
    # A conta de usuário do admin segue, com a sessão aberta.
    assert _query(migrated, "SELECT count(*) FROM sessions WHERE user_id = :u", u=ADMIN_A) == [(1,)]


def test_ids_e_contagens_do_conteudo_sao_preservados(migrated: dict[str, Any]) -> None:
    before = migrated["before"]
    for table in ("users", "recordings", "transcripts", "summaries"):
        ids = {row[0] for row in _query(migrated, f"SELECT id FROM {table}")}  # noqa: S608
        assert ids == before[table], table
    assert _query(migrated, "SELECT count(*) FROM segments") == [(before["segments"],)]
    assert dict(_query(migrated, "SELECT id, audio_key FROM recordings")) == before["audio_keys"]
    # Pessoas originais mantêm o id; as cópias somam.
    people = {row[0] for row in _query(migrated, "SELECT id FROM people")}
    assert before["people"] <= people


def test_owner_id_bate_com_o_dono_da_gravacao(migrated: dict[str, Any]) -> None:
    for table in ("transcription_jobs", "transcripts"):
        wrong = _query(
            migrated,
            f"SELECT count(*) FROM {table} x JOIN recordings r ON r.id = x.recording_id"  # noqa: S608
            " WHERE x.owner_id <> r.owner_id",
        )
        assert wrong == [(0,)], table
    for table in ("speakers", "segments", "speaker_embeddings", "summaries", "voice_samples", "speaker_suggestions"):
        wrong = _query(
            migrated,
            f"SELECT count(*) FROM {table} x JOIN transcripts t ON t.id = x.transcript_id"  # noqa: S608
            " WHERE x.owner_id <> t.owner_id",
        )
        assert wrong == [(0,)], table


def test_pessoa_usada_por_outro_usuario_vira_copia_dele(migrated: dict[str, Any]) -> None:
    # A original fica com quem a criou (ou com o admin mais antigo), com o mesmo id.
    owners = dict(_query(migrated, "SELECT id, owner_id FROM people WHERE id = ANY(:ids)", ids=[PERSON_1, PERSON_2]))
    assert owners == {PERSON_1: ADMIN_A, PERSON_2: ADMIN_A}
    assert _query(
        migrated, "SELECT person_id FROM speakers WHERE transcript_id = :t AND speaker_id = 'S1'", t=TR_1
    ) == [(PERSON_1,)]

    copies = dict(_query(migrated, "SELECT name, id FROM people WHERE owner_id = :u", u=MEMBER_A1))
    assert set(copies) == {"Rafael Lima", "Juliana Prado"}
    assert PERSON_1 not in copies.values()
    assert PERSON_2 not in copies.values()
    assert _query(migrated, "SELECT email, notes FROM people WHERE id = :p", p=copies["Rafael Lima"]) == [
        ("rafael@example.com", None)
    ]
    assert _query(
        migrated, "SELECT person_id FROM speakers WHERE transcript_id = :t AND speaker_id = 'S1'", t=TR_2
    ) == [(copies["Rafael Lima"],)]
    assert _query(migrated, "SELECT person_id FROM voice_samples WHERE transcript_id = :t", t=TR_2) == [
        (copies["Rafael Lima"],)
    ]
    assert _query(migrated, "SELECT person_id FROM voice_samples WHERE transcript_id = :t", t=TR_1) == [(PERSON_1,)]
    assert _query(migrated, "SELECT person_id FROM speaker_suggestions WHERE transcript_id = :t", t=TR_2) == [
        (copies["Juliana Prado"],)
    ]

    updated = dict(_query(migrated, "SELECT id, updated_at FROM transcripts"))
    before = migrated["before"]["updated_at"]
    assert updated[TR_2] > before[TR_2]
    assert updated[TR_1] == before[TR_1]
    assert updated[TR_3] == before[TR_3]
    # Quem não usava a pessoa não recebe cópia.
    assert _query(migrated, "SELECT count(*) FROM people WHERE owner_id = :u", u=MEMBER_A2) == [(0,)]


def test_cada_usuario_tem_os_templates_com_o_padrao_certo(migrated: dict[str, Any]) -> None:
    before = migrated["before"]
    org_templates = before["org_a_templates"]
    org_default = UUID(before["org_a_default"])

    def templates(user: UUID) -> dict[str, tuple[UUID, bool]]:
        rows = _query(migrated, "SELECT name, id, is_default FROM summary_templates WHERE owner_id = :u", u=user)
        return {name: (tid, default) for name, tid, default in rows}

    first = templates(ADMIN_A)
    assert {tid for tid, _ in first.values()} == set(org_templates)
    assert [tid for tid, default in first.values() if default] == [org_default]

    personal = templates(MEMBER_A1)
    assert set(personal) == {*org_templates.values(), "Pessoal"}
    assert [name for name, (_, default) in personal.items() if default] == ["Pessoal"]
    assert not {tid for tid, _ in personal.values()} & set(org_templates)

    member = templates(MEMBER_A2)
    assert set(member) == set(org_templates.values())
    assert [name for name, (_, default) in member.items() if default] == [org_templates[org_default]]

    other_org = templates(MEMBER_B)
    assert len(other_org) == 3  # cópias dos três padrões da outra organização
    assert [name for name, (_, default) in other_org.items() if default] == ["Ata de reunião"]

    seeded = templates(LONE_C)
    assert set(seeded) == {"Ata de reunião", "Resumo executivo", "Decisões e ações"}
    assert seeded["Ata de reunião"][1] is True
    assert _query(migrated, "SELECT count(*) FROM summary_templates WHERE owner_id IS NULL") == [(0,)]


def test_configuracao_e_segredos_vem_da_organizacao_mais_antiga(migrated: dict[str, Any]) -> None:
    [(summarization, voice, updated_by_email)] = _query(
        migrated,
        "SELECT s.summarization, s.voice_identification, a.email"
        " FROM platform_settings s LEFT JOIN admins a ON a.id = s.updated_by",
    )
    assert summarization == {"default_provider_id": str(PROVIDER), "auto_summarize": True}
    assert voice == {"enabled": True, "suggestion_threshold": 0.61}
    assert updated_by_email == "admin.a@example.com"
    assert _query(migrated, "SELECT name, value_encrypted FROM platform_secrets") == [("hf_token", "cifrado-hf-a")]
    assert _query(migrated, "SELECT id FROM agent_providers") == [(PROVIDER,)]


def test_sob_eclume_app_cada_um_so_enxerga_o_que_e_dele(migrated: dict[str, Any]) -> None:
    users = (ADMIN_A, MEMBER_A1, MEMBER_A2, ADMIN_B, MEMBER_B, LONE_C)
    for user in users:
        for table in CONTENT_TABLES:
            visible = _as_user(migrated, user, f"SELECT count(*) FROM {table}")  # noqa: S608
            owned = _query(migrated, f"SELECT count(*) FROM {table} WHERE owner_id = :u", u=user)  # noqa: S608
            assert visible == owned, (user, table)
        assert _as_user(migrated, user, "SELECT id FROM users") == [(user,)]
    # O que chegava por compartilhamento (grupo e organização) deixou de chegar.
    assert _as_user(migrated, MEMBER_A2, "SELECT id FROM recordings") == []
    assert _as_user(migrated, ADMIN_A, "SELECT id FROM recordings") == [(REC_1,)]
    assert _as_user(migrated, MEMBER_A1, "SELECT count(*) FROM api_tokens") == [(1,)]
    assert _as_user(migrated, MEMBER_A2, "SELECT count(*) FROM api_tokens") == [(0,)]
    # Busca pelo GIN restrita ao dono.
    matches = _as_user(
        migrated, MEMBER_A1, "SELECT transcript_id FROM eclume_segment_matches(to_tsquery('eclume_pt', 'turma'))"
    )
    assert matches == [(TR_2,)]
    # Providers e configuração da plataforma: leitura sem segredo.
    assert _as_user(migrated, MEMBER_A1, "SELECT name FROM agent_providers") == [("claude",)]
    assert len(_as_user(migrated, MEMBER_A1, "SELECT asr FROM platform_settings")) == 1


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT api_key_encrypted FROM agent_providers",
        "SELECT * FROM platform_secrets",
        "SELECT * FROM admins",
        "SELECT * FROM admin_sessions",
    ],
)
def test_eclume_app_nao_le_segredos_nem_contas_de_admin(migrated: dict[str, Any], sql: str) -> None:
    with pytest.raises(DBAPIError, match="permission denied"):
        _as_user(migrated, MEMBER_A1, sql)


def test_grants_do_dono_e_contas_sem_aceite(migrated: dict[str, Any]) -> None:
    # Esquecer a voz de uma pessoa passa a ser um DELETE comum do dono, sob a RLS.
    for table in ("voice_samples", "speaker_suggestions"):
        assert _query(migrated, "SELECT has_table_privilege('eclume_app', :t, 'DELETE')", t=table) == [(True,)]
    # As contas migradas nascem sem o aceite do aviso.
    assert _query(migrated, "SELECT count(*) FROM users WHERE notice_version IS NOT NULL") == [(0,)]
