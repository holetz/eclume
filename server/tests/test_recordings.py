"""Recordings: read, edit, delete, audio, progress, retranscription and sharing."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import uuid4

import redis
from sqlalchemy import text

from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import drain_storage, run_cpu, transcribed
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services


def test_listing_with_malformed_cursor_returns_422(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    api = as_user(make_user())
    # `["2026-01-01T00:00:00", 5]`: well-formed JSON, but the id is not text.
    response = api.get("/api/v1/recordings", params={"cursor": "WyIyMDI2LTAxLTAxVDAwOjAwOjAwIiwgNV0"})
    assert response.status_code == 422
    assert "cursor inválido" in response.text


def test_list_get_and_filter(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    first = upload_file(api, audio_bytes(100), tags=["cliente-a"])
    second = upload_file(api, audio_bytes(100), tags=["cliente-b"])
    listed = api.get("/api/v1/recordings").json()
    assert [r["id"] for r in listed["items"]] == [second["id"], first["id"]]
    assert listed["next_cursor"] is None
    assert [r["id"] for r in api.get("/api/v1/recordings", params={"tag": "cliente-a"}).json()["items"]] == [
        first["id"]
    ]
    assert api.get("/api/v1/recordings", params={"status": "transcribed"}).json()["items"] == []
    assert len(api.get("/api/v1/recordings", params={"status": "queued"}).json()["items"]) == 2
    paged = api.get("/api/v1/recordings", params={"limit": 1}).json()
    assert [r["id"] for r in paged["items"]] == [second["id"]]
    rest = api.get("/api/v1/recordings", params={"limit": 1, "cursor": paged["next_cursor"]}).json()
    assert [r["id"] for r in rest["items"]] == [first["id"]]
    assert api.get(f"/api/v1/recordings/{first['id']}").json()["tags"] == ["cliente-a"]
    since = api.get("/api/v1/recordings", params={"since": second["updated_at"]}).json()
    assert [r["id"] for r in since["items"]] == [second["id"]]


def _ids(api: Api, **params: object) -> list[str]:
    response = api.get("/api/v1/recordings", params=params)
    assert response.status_code == 200, response.text
    return [r["id"] for r in response.json()["items"]]


def test_library_by_range_and_filters(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())

    def recording(when: str, **fields: object) -> str:
        return upload_file(api, audio_bytes(100), recorded_at=when, **fields)["id"]

    a = recording("2026-09-01T10:00:00Z", tags=["x"])
    b = recording("2026-09-03T10:00:00Z", tags=["y"], kind="note")
    c = recording("2026-09-10T10:00:00Z", tags=["x", "z"])

    # The week: `from` inclusive, `to` exclusive, by the recording start.
    week = {"from": "2026-09-01T10:00:00Z", "to": "2026-09-10T10:00:00Z", "sort": "recorded_asc"}
    assert _ids(api, **week) == [a, b]
    assert _ids(api, sort="recorded_desc") == [c, b, a]
    # Paging by recording date, nothing is lost or repeated.
    seen, cursor = [], None
    while True:
        page = api.get(
            "/api/v1/recordings", params={"sort": "recorded_asc", "limit": 1} | ({"cursor": cursor} if cursor else {})
        ).json()
        seen += [r["id"] for r in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert seen == [a, b, c]

    # OR within the same filter, AND across filters.
    assert set(_ids(api, tag=["x", "y"])) == {a, b, c}
    assert _ids(api, tag="x", kind="meeting", sort="recorded_asc") == [a, c]
    assert _ids(api, tag="y", kind="meeting") == []
    assert _ids(api, kind="note") == [b]
    assert set(_ids(api, kind=["note", "meeting"])) == {a, b, c}
    assert set(_ids(api, status=["queued", "failed"])) == {a, b, c}

    # User fields: the value of a custom field and the built-in ones (title and tags).
    field = api.post("/api/v1/fields", json={"name": "Cliente", "kind": "text"}).json()
    team = api.post("/api/v1/fields", json={"name": "Equipes", "kind": "list"}).json()
    assert api.put(f"/api/v1/recordings/{a}/fields/{field['id']}", json={"value": "Serra Azul"}).status_code == 200
    assert api.put(f"/api/v1/recordings/{b}/fields/{field['id']}", json={"value": "Outro"}).status_code == 200
    assert api.put(f"/api/v1/recordings/{c}/fields/{team['id']}", json={"value": ["rh", "ti"]}).status_code == 200
    assert _ids(api, field=f"{field['id']}:Serra Azul") == [a]
    assert set(_ids(api, field=[f"{field['id']}:Serra Azul", f"{field['id']}:Outro"])) == {a, b}
    assert _ids(api, field=[f"{field['id']}:Serra Azul", f"{team['id']}:ti"]) == []
    assert _ids(api, field=f"{team['id']}:ti") == [c]
    tags_field = next(f for f in api.get("/api/v1/fields").json()["items"] if f["builtin"] == "tags")
    assert set(_ids(api, field=f"{tags_field['id']}:z")) == {c}
    assert api.get("/api/v1/recordings", params={"field": "sem-dois-pontos"}).status_code == 422


def test_library_by_person(as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services):
    api = as_user(make_user())
    with_rafael = transcribed(api, services.settings)
    without = transcribed(api, services.settings)
    rafael = api.post("/api/v1/people", json={"name": "Rafael Lima"}).json()
    linked = api.patch(
        f"/api/v1/transcripts/{with_rafael['transcript_id']}/speakers/S2", json={"person_id": rafael["id"]}
    )
    assert linked.status_code == 200, linked.text
    assert _ids(api, person=rafael["id"]) == [with_rafael["id"]]
    assert without["id"] in _ids(api)


def test_library_by_attributes_of_the_same_participant(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    both = transcribed(api, services.settings)
    split = transcribed(api, services.settings)
    nobody = transcribed(api, services.settings)
    rafael = api.post(
        "/api/v1/people", json={"name": "Rafael", "company": "Metalúrgica Serra Azul", "tags": ["Cliente"]}
    ).json()
    ana = api.post("/api/v1/people", json={"name": "Ana", "company": "Metalúrgica Serra Azul"}).json()
    bruno = api.post("/api/v1/people", json={"name": "Bruno", "department": "RH", "tags": ["cliente"]}).json()

    def link(recording: dict[str, Any], speaker: str, person: dict[str, Any]) -> None:
        linked = api.patch(
            f"/api/v1/transcripts/{recording['transcript_id']}/speakers/{speaker}", json={"person_id": person["id"]}
        )
        assert linked.status_code == 200, linked.text

    link(both, "S1", rafael)
    # The company and the tag are in the recording, but on different people.
    link(split, "S1", ana)
    link(split, "S2", bruno)

    org = "metalurgica serra azul"
    assert set(_ids(api, person_company=org)) == {both["id"], split["id"]}
    assert set(_ids(api, person_tag="CLIENTE")) == {both["id"], split["id"]}
    assert _ids(api, person_company=org, person_tag="cliente") == [both["id"]]
    assert _ids(api, person_department="rh") == [split["id"]]
    assert set(_ids(api, person_department=["rh", "Financeiro"], person_tag="cliente")) == {split["id"]}
    assert _ids(api, person_company="Outra") == []
    assert nobody["id"] not in _ids(api, person_tag="cliente")


def test_edit_metadata_owner_only(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    owner = as_user(make_user())
    recording = upload_file(owner, audio_bytes(100))
    patched = owner.patch(
        f"/api/v1/recordings/{recording['id']}",
        json={"title": "Novo título", "tags": ["a", "b"], "metadata": {"projeto": "X"}, "language": "pt-BR"},
    )
    assert patched.status_code == 200
    body = patched.json()
    assert (body["title"], body["tags"], body["metadata"], body["language"]) == (
        "Novo título",
        ["a", "b"],
        {"projeto": "X"},
        "pt-BR",
    )
    assert body["updated_at"] > recording["updated_at"]
    # Correcting the date makes it user-provided; the kind changes by hand.
    assert recording["recorded_at_source"] == "upload"
    redated = owner.patch(
        f"/api/v1/recordings/{recording['id']}", json={"recorded_at": "2026-09-01T10:00:00Z", "kind": "note"}
    ).json()
    assert (redated["recorded_at"], redated["recorded_at_source"], redated["kind"]) == (
        "2026-09-01T10:00:00Z",
        "user",
        "note",
    )
    assert owner.patch(f"/api/v1/recordings/{recording['id']}", json={"kind": None}).status_code == 422
    assert owner.patch(f"/api/v1/recordings/{recording['id']}", json={}).status_code == 422
    assert owner.patch(f"/api/v1/recordings/{recording['id']}", json={"title": None}).status_code == 422
    assert (
        owner.patch(
            f"/api/v1/recordings/{recording['id']}", json={"collection_ids": ["01928f3a-1c00-7a00-8000-000000000801"]}
        ).status_code
        == 422
    )


def test_delete_removes_audio(as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services):
    account = make_user()
    api = as_user(account)
    recording = upload_file(api, audio_bytes(100))
    key = f"users/{account.user_id}/recordings/{recording['id']}/audio"
    s3 = services.s3()
    assert s3.list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=key)["KeyCount"] == 1
    assert api.delete(f"/api/v1/recordings/{recording['id']}").status_code == 204
    assert api.get(f"/api/v1/recordings/{recording['id']}").status_code == 404
    # The audio leaves through the deletion queue, on drain.
    drain_storage(services.settings)
    assert s3.list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=key)["KeyCount"] == 0


def _count(services: Services, sql: str, **params: Any) -> int:  # noqa: ANN401
    async def go(conn: Any) -> int:  # noqa: ANN401
        return (await conn.execute(text(sql), params)).scalar_one()

    return run(services.sql(go))


def test_delete_takes_summary_chat_markers_and_audio(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user()
    api = as_user(account)
    recording = transcribed(api, services.settings, markers=[{"client_id": str(uuid4()), "at_ms": 1000}])
    rid, tid = recording["id"], recording["transcript_id"]
    admin.post("/api/v1/admin/agent-providers", json={"name": "Claude", "kind": "claude-cli", "model": "sonnet"})
    types = api.get("/api/v1/agenda-types").json()["items"]
    done = api.post(f"/api/v1/transcripts/{tid}/summaries", json={"agenda_type_id": types[0]["id"]})
    assert done.status_code == 202, done.text
    run_cpu(services.settings)
    # A summary still queued when the recording goes away, and an adjustment request already made.
    queued = api.post(f"/api/v1/transcripts/{tid}/summaries", json={"agenda_type_id": types[0]["id"]})
    assert queued.status_code == 202, queued.text

    async def chat(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(
            text(
                "INSERT INTO summary_chat_messages (owner_id, recording_id, transcript_id, role, content, status)"
                " VALUES (:o, :r, :t, 'user', 'Encurte', 'done')"
            ),
            {"o": account.user_id, "r": rid, "t": tid},
        )

    run(services.sql(chat))
    counts = {
        "summaries": "SELECT count(*) FROM summaries WHERE transcript_id = :t",
        "chat": "SELECT count(*) FROM summary_chat_messages WHERE recording_id = :r",
        "markers": "SELECT count(*) FROM markers WHERE recording_id = :r",
    }
    assert {name: _count(services, sql, t=tid, r=rid) for name, sql in counts.items()} == {
        "summaries": 2,
        "chat": 1,
        "markers": 1,
    }
    key = f"users/{account.user_id}/recordings/{rid}/audio"
    s3 = services.s3()
    assert s3.list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=key)["KeyCount"] == 1

    assert api.delete(f"/api/v1/recordings/{rid}").status_code == 204
    assert {name: _count(services, sql, t=tid, r=rid) for name, sql in counts.items()} == {
        "summaries": 0,
        "chat": 0,
        "markers": 0,
    }
    drain_storage(services.settings)
    assert s3.list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=key)["KeyCount"] == 0
    # The summary that was queued finds the recording deleted and does nothing.
    agents = run_cpu(services.settings)
    assert agents.calls == []


def test_audio_redirects_to_signed_url_with_range(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    data = audio_bytes(5000)
    recording = upload_file(api, data)
    redirect = api.get(f"/api/v1/recordings/{recording['id']}/audio", follow_redirects=False)
    assert redirect.status_code == 302
    location = redirect.headers["location"]
    assert location.startswith(f"https://testserver/media/recordings/{recording['id']}/audio?")
    api.client.cookies.clear()
    whole = api.client.get(location)
    assert whole.status_code == 200
    assert whole.content == data
    partial = api.client.get(location, headers={"Range": "bytes=100-199"})
    assert partial.status_code == 206
    assert partial.content == data[100:200]
    assert partial.headers["content-range"] == f"bytes 100-199/{len(data)}"
    assert api.client.get(location.replace("sig=", "sig=0")).status_code == 401


def test_worker_progress_shows_in_the_job(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(100))
    client = redis.Redis.from_url(services.settings.redis_url)
    client.hset(
        f"eclume:progress:{recording['id']}",
        mapping={"stage": "diarize", "pct": "40", "updated_at": "2026-09-18T14:09:35Z"},
    )
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["status"] == "processing"
    assert body["job"]["state"] == "running"
    assert body["job"]["stage"] == "diarization"
    assert body["job"]["progress"] == 0.4
    assert [r["id"] for r in api.get("/api/v1/recordings", params={"status": "processing"}).json()["items"]] == [
        recording["id"]
    ]
    assert api.get("/api/v1/recordings", params={"status": "queued"}).json()["items"] == []


def test_progress_of_another_revision_does_not_show(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(100))
    client = redis.Redis.from_url(services.settings.redis_url)
    key = f"eclume:progress:{recording['id']}"
    # The open job is revision 1; the leftover hash belongs to another revision.
    client.hset(key, mapping={"revision": "2", "stage": "diarize", "pct": "40", "updated_at": "2026-09-18T14:09:35Z"})
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["status"] == "queued"
    assert body["job"]["state"] == "queued"
    assert (body["job"]["stage"], body["job"]["progress"]) == (None, 0.0)
    client.hset(key, mapping={"revision": "1"})
    assert api.get(f"/api/v1/recordings/{recording['id']}").json()["job"]["progress"] == 0.4


def test_retranscribe_only_without_a_job_in_progress(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(100))
    busy = api.post(f"/api/v1/recordings/{recording['id']}/retranscribe")
    assert busy.status_code == 409

    from sqlalchemy import text  # noqa: PLC0415

    from eclume_server_testing.harness import run  # noqa: PLC0415

    async def finish(conn):  # noqa: ANN001, ANN202
        await conn.execute(
            text(
                "UPDATE transcription_jobs SET state = 'failed', error_code = 'engine_error' WHERE recording_id = :id"
            ),
            {"id": recording["id"]},
        )

    run(services.sql(finish))
    again = api.post(f"/api/v1/recordings/{recording['id']}/retranscribe", json={"language": "en"})
    assert again.status_code == 202
    assert again.json()["job"]["state"] == "queued"
    assert again.json()["language"] == "en"
    assert redis.Redis.from_url(services.settings.redis_url).zscore("eclume:gpu", f"transcribe:{recording['id']}:2")


_SECOND_REVISION = (
    "INSERT INTO transcription_jobs (owner_id, recording_id, revision, state, options) "
    "SELECT owner_id, id, 2, 'queued', '{}' FROM recordings WHERE id = :id"
)


def test_retranscribe_in_a_race_returns_409(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(102))
    rid = recording["id"]

    from sqlalchemy import text  # noqa: PLC0415

    from eclume_server_testing.harness import run, while_recording_locked  # noqa: PLC0415

    async def failed(conn):  # noqa: ANN001, ANN202
        await conn.execute(
            text(
                "UPDATE transcription_jobs SET state = 'failed', error_code = 'engine_error' WHERE recording_id = :id"
            ),
            {"id": rid},
        )

    run(services.sql(failed))
    # The first request holds the recording and creates revision 2; the second, waiting on the lock, sees the new job.
    second = run(
        while_recording_locked(
            services, rid, lambda: api.post(f"/api/v1/recordings/{rid}/retranscribe"), _SECOND_REVISION, id=rid
        )
    )
    assert second.status_code == 409, second.text
    assert second.headers["content-type"].startswith("application/problem+json")
    assert api.get(f"/api/v1/recordings/{rid}").json()["job"]["state"] == "queued"
    run(services.sql(failed))


def _cancel_requested(services: Services, recording_id: str, revision: int = 1) -> bool:
    return bool(redis.Redis.from_url(services.settings.redis_url).exists(f"eclume:cancel:{recording_id}:{revision}"))


def test_cancel_the_running_transcription(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(103))
    rid = recording["id"]
    # The GPU worker is preprocessing this revision.
    redis.Redis.from_url(services.settings.redis_url).hset(
        f"eclume:progress:{rid}", mapping={"revision": "1", "stage": "preprocess", "pct": "5", "updated_at": "agora"}
    )
    assert api.pat("recordings:read").post(f"/api/v1/recordings/{rid}/cancel").status_code == 403

    cancelled = api.post(f"/api/v1/recordings/{rid}/cancel")
    assert cancelled.status_code == 202, cancelled.text
    body = cancelled.json()
    assert body["status"] == "failed"
    assert body["job"]["state"] == "cancelled"
    assert body["job"]["error"] == {"code": "cancelled", "message": "Transcrição cancelada.", "retryable": True}
    assert body["job"]["finished_at"] is not None
    steps = {step["step"]: step for step in body["pipeline"]}
    assert (steps["preprocessing"]["state"], steps["preprocessing"]["reason"]) == ("skipped", "cancelled")
    assert steps["transcription"]["state"] == "pending"
    assert _cancel_requested(services, rid)

    # With no open job, 409; "Transcrever de novo" is the way back.
    again = api.post(f"/api/v1/recordings/{rid}/cancel")
    assert (again.status_code, again.headers["content-type"]) == (409, "application/problem+json")
    retried = api.post(f"/api/v1/recordings/{rid}/retranscribe")
    assert retried.status_code == 202
    assert retried.json()["job"]["state"] == "queued"
    assert not _cancel_requested(services, rid, 2)


def test_cancel_while_queued_skips_the_transcription(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(104))
    body = api.post(f"/api/v1/recordings/{recording['id']}/cancel").json()
    steps = {step["step"]: step for step in body["pipeline"]}
    assert (steps["transcription"]["state"], steps["transcription"]["reason"]) == ("skipped", "cancelled")
    other = as_user(make_user())
    assert other.post(f"/api/v1/recordings/{recording['id']}/cancel").status_code == 404


def test_deleting_the_recording_cancels_the_open_job(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(105))
    assert api.delete(f"/api/v1/recordings/{recording['id']}").status_code == 204
    assert _cancel_requested(services, recording["id"])


def test_delete_by_pat_requires_recordings_delete(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    session = as_user(make_user())
    recording = upload_file(session, audio_bytes(101))
    writer = session.pat("recordings:read", "recordings:write")
    denied = writer.delete(f"/api/v1/recordings/{recording['id']}")
    assert denied.status_code == 403
    assert denied.json()["required_scopes"] == ["recordings:delete"]
    deleter = session.pat("recordings:delete")
    assert deleter.delete(f"/api/v1/recordings/{recording['id']}").status_code == 204
    assert session.get(f"/api/v1/recordings/{recording['id']}").status_code == 404


def test_stale_owner_is_the_user_itself_without_a_join(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    from eclume_server.recordings import recording_select  # noqa: PLC0415
    from eclume_server.transcripts import transcript_select  # noqa: PLC0415

    account = make_user(name="Mariana Couto")
    api = as_user(account)
    recording = upload_file(api, audio_bytes(106))
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["owner"] == {"id": str(account.user_id), "name": "Mariana Couto"}
    # The name comes from the transaction user, not from a per-row join with `users`.
    for query in (recording_select(), transcript_select()):
        assert "JOIN users" not in str(query)
