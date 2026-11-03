"""Isolation: each account sees only what is its own.

Proved twice: through the API (404, without telling "does not exist" from "is not yours") and through
direct SQL under the `eclume_app` role with `app.user_id` set — what RLS guarantees even if a route
forgets a filter.
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

# Every content table has `owner_id` and the `<table>_own` policy (migrations 008 onwards).
CONTENT_TABLES = (
    "recordings",
    "uploads",
    "collections",
    "agenda_types",
    "fields",
    "field_values",
    "pipeline_steps",
    "people",
    "transcription_jobs",
    "transcripts",
    "speakers",
    "segments",
    "speaker_embeddings",
    "summaries",
    "summary_chat_messages",
    "markers",
    "voice_samples",
    "speaker_suggestions",
)


def _as_app(services: Services, user_id: UUID | None, sql: str, **params: Any) -> Any:  # noqa: ANN401
    """Run `sql` as `eclume_app` with the given RLS context; return the rows or the rowcount."""

    async def go(conn: Any) -> Any:  # noqa: ANN401
        await conn.execute(text("SET LOCAL ROLE eclume_app"))
        if user_id is not None:
            await conn.execute(text("SELECT set_config('app.user_id', :user, true)"), {"user": str(user_id)})
        result = await conn.execute(text(sql), params)
        return [tuple(row) for row in result] if result.returns_rows else result.rowcount

    return run(services.sql(go))


def _owned(services: Services, table: str, owner: UUID) -> int:
    """The owner's rows in the table, through the connection role (outside RLS)."""

    async def go(conn: Any) -> int:  # noqa: ANN401
        sql = f"SELECT count(*) FROM {table} WHERE owner_id = :o"  # noqa: S608
        return (await conn.execute(text(sql), {"o": owner})).scalar_one()

    return run(services.sql(go))


def _seed_voice(services: Services, transcript_id: str, person_id: str) -> None:
    """Embedding, sample and suggestion on the transcript, through the connection role (like ingestion)."""

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
    # An upload in progress, a summary, an adjustment request and a marker, so every content table
    # has a row of Alice's (the upload title is already a field value).
    apis["alice"].post(
        "/api/v1/uploads",
        json={"filename": "b.ogg", "content_type": "audio/ogg", "size_bytes": 10, "sha256": "0" * 64},
    )

    async def summary(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(
            text(
                "INSERT INTO summaries (owner_id, transcript_id, transcript_revision, agenda_type_id, agenda_type_name,"
                " instructions, version, status, trigger, provider_id, provider_name, provider_kind, model)"
                " SELECT owner_id, id, revision, gen_random_uuid(), 'Ata', 'x', 1, 'done', 'manual',"
                " gen_random_uuid(), 'p', 'claude-cli', 'm' FROM transcripts WHERE id = :t"
            ),
            {"t": recording["transcript_id"]},
        )
        await conn.execute(
            text(
                "INSERT INTO summary_chat_messages (owner_id, recording_id, transcript_id, role, content, status)"
                " SELECT owner_id, recording_id, id, 'user', 'Encurte', 'done' FROM transcripts WHERE id = :t"
            ),
            {"t": recording["transcript_id"]},
        )
        await conn.execute(
            text(
                "INSERT INTO markers (owner_id, recording_id, client_id, at_ms)"
                " SELECT owner_id, id, gen_random_uuid(), 1000 FROM recordings WHERE id = :r"
            ),
            {"r": recording["id"]},
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


def test_each_account_sees_only_its_own_via_api_and_via_sql(scenario: dict[str, Any], services: Services):
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
        # Bob sees only his own (the agenda types seeded at signup), nothing of Alice's.
        assert _as_app(services, bob.user_id, count)[0][0] == _owned(services, table, bob.user_id), table
        of_alice = f"SELECT count(*) FROM {table} WHERE owner_id = :o"  # noqa: S608
        assert _as_app(services, bob.user_id, of_alice, o=alice.user_id)[0][0] == 0, table

    # Writing from outside does not get through either: nothing is changed or removed.
    rid = recording["id"]
    assert apis["bob"].patch(f"/api/v1/recordings/{rid}", json={"title": "x"}).status_code == 404
    assert apis["bob"].delete(f"/api/v1/recordings/{rid}").status_code == 404
    for sql in (
        "UPDATE recordings SET title = 'invadido' WHERE id = :r",
        "DELETE FROM recordings WHERE id = :r",
        "UPDATE people SET name = 'invadido' WHERE owner_id = :o",
        "DELETE FROM voice_samples WHERE owner_id = :o",
        "DELETE FROM markers WHERE owner_id = :o",
        "DELETE FROM summary_chat_messages WHERE owner_id = :o",
        "UPDATE users SET name = 'invadido' WHERE id = :o",
    ):
        assert _as_app(services, bob.user_id, sql, r=rid, o=alice.user_id) == 0, sql
    assert apis["alice"].get(f"/api/v1/recordings/{rid}").json()["title"] == "Reunião sigilosa"

    # Not even through SQL does Bob write anything on Alice's behalf.
    with pytest.raises(DBAPIError, match="row-level security"):
        _as_app(
            services,
            bob.user_id,
            "INSERT INTO collections (owner_id, name) VALUES (:o, 'Intrusa')",
            o=alice.user_id,
        )


@pytest.mark.parametrize(
    "sql",
    [
        (
            "INSERT INTO transcription_jobs (owner_id, recording_id, revision, state)"
            " SELECT :o, recording_id, 99, 'queued' FROM transcripts WHERE id = :t"
        ),
        (
            "INSERT INTO summaries (owner_id, transcript_id, transcript_revision, agenda_type_id, agenda_type_name,"
            " instructions, version, status, trigger, provider_id, provider_name, provider_kind, model)"
            " VALUES (:o, :t, 1, gen_random_uuid(), 'Ata', 'x', 99, 'done', 'manual', gen_random_uuid(), 'p',"
            " 'claude-cli', 'm')"
        ),
        "UPDATE segments SET owner_id = :o WHERE transcript_id = :t",
        (
            "INSERT INTO summary_chat_messages (owner_id, recording_id, transcript_id, role, content, status)"
            " SELECT :o, recording_id, id, 'user', 'x', 'done' FROM transcripts WHERE id = :t"
        ),
        (
            "INSERT INTO markers (owner_id, recording_id, client_id, at_ms)"
            " SELECT :o, recording_id, gen_random_uuid(), 0 FROM transcripts WHERE id = :t"
        ),
        (
            "UPDATE recordings SET agenda_type_id = (SELECT id FROM agenda_types WHERE owner_id = :o LIMIT 1)"
            " WHERE id = (SELECT recording_id FROM transcripts WHERE id = :t)"
        ),
    ],
)
def test_child_only_has_the_parents_owner(scenario: dict[str, Any], services: Services, sql: str):
    """Not even the connection role (outside RLS) links one account's content to another's: composite FKs."""
    bob = scenario["accounts"]["bob"]

    async def go(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(text(sql), {"o": bob.user_id, "t": scenario["recording"]["transcript_id"]})

    with pytest.raises(DBAPIError, match="foreign key"):
        run(services.sql(go))


def test_without_rls_context_nothing_is_visible(scenario: dict[str, Any], services: Services):
    for table in (*CONTENT_TABLES, "users", "api_tokens", "pairing_codes"):
        assert _as_app(services, None, f"SELECT count(*) FROM {table}")[0][0] == 0, table  # noqa: S608
    del scenario


def test_each_one_sees_only_their_own_account(make_user: Callable[..., Account], services: Services):
    alice, bob = make_user(), make_user()
    assert _as_app(services, alice.user_id, "SELECT id FROM users") == [(alice.user_id,)]
    rename = "UPDATE users SET name = 'Novo nome' WHERE id = :u"
    assert _as_app(services, alice.user_id, rename, u=str(bob.user_id)) == 0
    assert _as_app(services, alice.user_id, rename, u=str(alice.user_id)) == 1


def test_another_users_pat_sees_nothing(scenario: dict[str, Any]):
    recording = scenario["recording"]
    bobs_lumea = scenario["apis"]["bob"].pat("transcripts:read", "recordings:read")
    assert bobs_lumea.get(f"/api/v1/transcripts/{recording['transcript_id']}").status_code == 404
    assert bobs_lumea.get("/api/v1/transcripts").json()["items"] == []


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT * FROM platform_secrets",
        "SELECT api_key_encrypted FROM agent_providers",
        "SELECT * FROM admins",
        "SELECT * FROM admin_sessions",
        "SELECT * FROM sessions",
        "SELECT * FROM storage_deletions",
        "UPDATE platform_settings SET updated_at = now()",
    ],
)
def test_eclume_app_does_not_reach_the_platform(make_user: Callable[..., Account], services: Services, sql: str):
    with pytest.raises(DBAPIError, match="permission denied"):
        _as_app(services, make_user().user_id, sql)


def test_connection_role_is_neither_superuser_nor_owner(services: Services):
    """The suite connects as `eclume_server`: no superuser, no DDL, owner of nothing, member of `eclume_app`."""

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
