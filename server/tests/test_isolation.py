"""Isolamento: cada conta enxerga só o que é dela.

Provado duas vezes: pela API (404, sem distinguir "não existe" de "não é de você") e por SQL direto
sob o papel `eclume_app` com `app.user_id` fixado — o que a RLS garante mesmo que uma rota esqueça
um filtro.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import run_cpu, run_gpu
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable
    from uuid import UUID

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

# Toda tabela de conteúdo tem `owner_id` e a política `<tabela>_own` (migration 008).
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


def _as_app(services: Services, user_id: UUID | None, sql: str, **params: Any) -> Any:  # noqa: ANN401
    """Roda `sql` como `eclume_app` com o contexto de RLS dado; devolve as linhas ou o rowcount."""

    async def go(conn: Any) -> Any:  # noqa: ANN401
        await conn.execute(text("SET LOCAL ROLE eclume_app"))
        if user_id is not None:
            await conn.execute(text("SELECT set_config('app.user_id', :user, true)"), {"user": str(user_id)})
        result = await conn.execute(text(sql), params)
        return [tuple(row) for row in result] if result.returns_rows else result.rowcount

    return run(services.sql(go))


def _owned(services: Services, table: str, owner: UUID) -> int:
    """Linhas da tabela do dono, pelo papel de conexão (fora da RLS)."""

    async def go(conn: Any) -> int:  # noqa: ANN401
        sql = f"SELECT count(*) FROM {table} WHERE owner_id = :o"  # noqa: S608
        return (await conn.execute(text(sql), {"o": owner})).scalar_one()

    return run(services.sql(go))


def _seed_voice(services: Services, transcript_id: str, person_id: str) -> None:
    """Embedding, amostra e sugestão na transcrição, pelo papel de conexão (como a ingestão)."""

    async def go(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(
            text(
                "INSERT INTO speaker_embeddings (transcript_id, owner_id, speaker_id, model, embedding)"
                " SELECT id, owner_id, 'S1', 'm', '[1,0,0]' FROM transcripts WHERE id = :t"
            ),
            {"t": transcript_id},
        )
        await conn.execute(
            text("UPDATE speakers SET person_id = :p WHERE transcript_id = :t AND speaker_id = 'S1'"),
            {"t": transcript_id, "p": person_id},
        )
        await conn.execute(
            text(
                "INSERT INTO voice_samples (transcript_id, speaker_id, owner_id, person_id, model, embedding, talk_ms)"
                " SELECT id, 'S1', owner_id, :p, 'm', '[1,0,0]', 1 FROM transcripts WHERE id = :t"
            ),
            {"t": transcript_id, "p": person_id},
        )
        await conn.execute(
            text(
                "INSERT INTO speaker_suggestions (transcript_id, speaker_id, owner_id, person_id, score)"
                " SELECT id, 'S2', owner_id, :p, 0.9 FROM transcripts WHERE id = :t"
            ),
            {"t": transcript_id, "p": person_id},
        )

    run(services.sql(go))


@pytest.fixture
def scenario(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
) -> dict[str, Any]:
    alice, bob = make_user(name="Alice"), make_user(name="Bob")
    apis = {"alice": as_user(alice), "bob": as_user(bob)}
    recording = upload_file(apis["alice"], audio_bytes(3000), title="Reunião sigilosa")
    run_gpu(services.settings)
    run_cpu(services.settings)
    recording = apis["alice"].get(f"/api/v1/recordings/{recording['id']}").json()
    assert recording["status"] == "transcribed"
    person = apis["alice"].post("/api/v1/people", json={"name": "Rafael Lima"}).json()
    apis["alice"].post("/api/v1/collections", json={"name": "Cliente X"})
    _seed_voice(services, recording["transcript_id"], person["id"])
    # Um upload em andamento e um resumo, para toda tabela de conteúdo ter linha da Alice.
    apis["alice"].post(
        "/api/v1/uploads",
        json={"filename": "b.ogg", "content_type": "audio/ogg", "size_bytes": 10, "sha256": "0" * 64},
    )

    async def summary(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(
            text(
                "INSERT INTO summaries (owner_id, transcript_id, transcript_revision, template_id, template_name,"
                " instructions, version, status, trigger, provider_id, provider_name, provider_kind, model)"
                " SELECT owner_id, id, revision, gen_random_uuid(), 'Ata', 'x', 1, 'done', 'manual',"
                " gen_random_uuid(), 'p', 'claude-cli', 'm' FROM transcripts WHERE id = :t"
            ),
            {"t": recording["transcript_id"]},
        )

    run(services.sql(summary))
    return {"accounts": {"alice": alice, "bob": bob}, "apis": apis, "recording": recording, "person": person}


def _api_sees(api: Api, recording: dict[str, Any]) -> bool:
    rid, tid = recording["id"], recording["transcript_id"]
    probes = [
        api.get(f"/api/v1/recordings/{rid}"),
        api.get(f"/api/v1/recordings/{rid}/audio", follow_redirects=False),
        api.get(f"/api/v1/transcripts/{tid}"),
        api.get(f"/api/v1/transcripts/{tid}/export", params={"format": "md"}),
        api.get(f"/api/v1/transcripts/{tid}/summaries"),
    ]
    statuses = {p.status_code for p in probes}
    assert statuses in ({404}, {200, 302}), statuses
    listed_recordings = [r["id"] for r in api.get("/api/v1/recordings").json()["items"]]
    listed_transcripts = [t["id"] for t in api.get("/api/v1/transcripts").json()["items"]]
    assert (rid in listed_recordings) == (tid in listed_transcripts) == (statuses != {404})
    return statuses != {404}


def test_cada_conta_so_enxerga_o_que_e_dela_via_api_e_via_sql(scenario: dict[str, Any], services: Services):
    accounts, apis, recording = scenario["accounts"], scenario["apis"], scenario["recording"]
    alice, bob = accounts["alice"], accounts["bob"]
    assert _api_sees(apis["alice"], recording)
    assert not _api_sees(apis["bob"], recording)
    assert apis["bob"].get(f"/api/v1/people/{scenario['person']['id']}").status_code == 404
    assert apis["bob"].get("/api/v1/people").json()["items"] == []

    for table in CONTENT_TABLES:
        owned = _owned(services, table, alice.user_id)
        assert owned > 0, table
        count = f"SELECT count(*) FROM {table}"  # noqa: S608
        assert _as_app(services, alice.user_id, count)[0][0] == owned, table
        # Bob vê só as dele (os templates semeados no cadastro), nada da Alice.
        assert _as_app(services, bob.user_id, count)[0][0] == _owned(services, table, bob.user_id), table
        of_alice = f"SELECT count(*) FROM {table} WHERE owner_id = :o"  # noqa: S608
        assert _as_app(services, bob.user_id, of_alice, o=alice.user_id)[0][0] == 0, table

    # Escrever por fora também não passa: nada é alterado nem removido.
    rid = recording["id"]
    assert apis["bob"].patch(f"/api/v1/recordings/{rid}", json={"title": "x"}).status_code == 404
    assert apis["bob"].delete(f"/api/v1/recordings/{rid}").status_code == 404
    for sql in (
        "UPDATE recordings SET title = 'invadido' WHERE id = :r",
        "DELETE FROM recordings WHERE id = :r",
        "UPDATE people SET name = 'invadido' WHERE owner_id = :o",
        "DELETE FROM voice_samples WHERE owner_id = :o",
        "UPDATE users SET name = 'invadido' WHERE id = :o",
    ):
        assert _as_app(services, bob.user_id, sql, r=rid, o=alice.user_id) == 0, sql
    assert apis["alice"].get(f"/api/v1/recordings/{rid}").json()["title"] == "Reunião sigilosa"

    # Nem por SQL Bob grava algo em nome da Alice.
    with pytest.raises(DBAPIError, match="row-level security"):
        _as_app(
            services,
            bob.user_id,
            "INSERT INTO collections (owner_id, name) VALUES (:o, 'Intrusa')",
            o=alice.user_id,
        )


def test_sem_contexto_de_rls_nada_e_visivel(scenario: dict[str, Any], services: Services):
    for table in (*CONTENT_TABLES, "users", "api_tokens"):
        assert _as_app(services, None, f"SELECT count(*) FROM {table}")[0][0] == 0, table  # noqa: S608
    del scenario


def test_cada_um_ve_so_a_propria_conta(make_user: Callable[..., Account], services: Services):
    alice, bob = make_user(), make_user()
    assert _as_app(services, alice.user_id, "SELECT id FROM users") == [(alice.user_id,)]
    rename = "UPDATE users SET name = 'Novo nome' WHERE id = :u"
    assert _as_app(services, alice.user_id, rename, u=str(bob.user_id)) == 0
    assert _as_app(services, alice.user_id, rename, u=str(alice.user_id)) == 1


def test_pat_de_outro_usuario_nao_enxerga_nada(scenario: dict[str, Any]):
    recording = scenario["recording"]
    lumea_do_bob = scenario["apis"]["bob"].pat("transcripts:read", "recordings:read")
    assert lumea_do_bob.get(f"/api/v1/transcripts/{recording['transcript_id']}").status_code == 404
    assert lumea_do_bob.get("/api/v1/transcripts").json()["items"] == []


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT * FROM platform_secrets",
        "SELECT api_key_encrypted FROM agent_providers",
        "SELECT * FROM admins",
        "SELECT * FROM admin_sessions",
        "SELECT * FROM sessions",
        "UPDATE platform_settings SET updated_at = now()",
    ],
)
def test_eclume_app_nao_alcanca_a_plataforma(make_user: Callable[..., Account], services: Services, sql: str):
    with pytest.raises(DBAPIError, match="permission denied"):
        _as_app(services, make_user().user_id, sql)


def test_papel_de_conexao_nao_e_superusuario_nem_dono(services: Services):
    """A suíte conecta como `eclume_server`: sem superusuário, sem DDL, dono de nada, membro de `eclume_app`."""

    async def attributes(conn: Any) -> Any:  # noqa: ANN401
        role = (
            await conn.execute(
                text(
                    "SELECT current_user, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,"
                    " pg_has_role(current_user, 'eclume_app', 'MEMBER'),"
                    " (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
                    "   WHERE n.nspname = 'public' AND c.relowner = r.oid)"
                    " FROM pg_roles r WHERE rolname = current_user"
                )
            )
        ).one()
        return tuple(role)

    assert run(services.sql(attributes)) == ("eclume_server", False, True, False, False, True, 0)

    async def create_table(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(text("CREATE TABLE intrusa (id int)"))

    with pytest.raises(DBAPIError, match="permission denied"):
        run(services.sql(create_table))

    async def write_migrations(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(text("DELETE FROM schema_migrations"))

    with pytest.raises(DBAPIError, match="permission denied"):
        run(services.sql(write_migrations))
