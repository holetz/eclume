"""Audio retention: the account preference, the ceiling, the daily purge and a recording without audio."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text

from eclume_server.audio_retention import effective_days, purge_due_audio
from eclume_server.db.session import make_engine
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import drain_storage, transcribed
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

URL = "/api/v1/me/audio-retention"
ADMIN = "/api/v1/admin/settings"


def _sql(services: Services, statement: str, **params: Any) -> list[Any]:  # noqa: ANN401
    async def go(conn: Any) -> list[Any]:  # noqa: ANN401
        result = await conn.execute(text(statement), params)
        return result.all() if result.returns_rows else []

    return run(services.sql(go))


def _purge(services: Services, now: datetime) -> int:
    async def go() -> int:
        engine = make_engine(services.settings.database_url)
        try:
            return await purge_due_audio(engine, now)
        finally:
            await engine.dispose()

    return run(go())


def _object_count(services: Services, key: str) -> int:
    return services.s3().list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=key)["KeyCount"]


def _audio_key(services: Services, recording_id: str) -> str | None:
    return _sql(services, "SELECT audio_key FROM recordings WHERE id = :r", r=recording_id)[0][0]


@pytest.mark.parametrize(
    ("user", "ceiling", "expected"),
    [(None, None, None), (None, 30, None), (90, None, 90), (90, 30, 30), (10, 30, 10)],
)
def test_effective_days(user: int | None, ceiling: int | None, expected: int | None):
    assert effective_days(user, ceiling) == expected


def test_preference_defaults_off_and_is_capped_by_the_ceiling(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], admin: Api
):
    owner = as_user(make_user())
    assert owner.get(URL).json() == {"days": None, "max_days": None, "effective_days": None}
    assert owner.patch(URL, json={"days": 90}).json() == {"days": 90, "max_days": None, "effective_days": 90}
    assert admin.patch(ADMIN, json={"retention": {"audio_max_days": 30}}).status_code == 200
    # The value typed stays; the window in force is the capped one.
    assert owner.get(URL).json() == {"days": 90, "max_days": 30, "effective_days": 30}
    assert owner.patch(URL, json={"days": None}).json() == {"days": None, "max_days": 30, "effective_days": None}
    assert admin.patch(ADMIN, json={"retention": {"audio_max_days": None}}).json()["retention"] == {
        "audio_max_days": None
    }


def test_preference_validation_and_scopes(make_user: Callable[..., Account], as_user: Callable[[Account], Api]):
    owner = as_user(make_user())
    for body in ({}, {"days": 0}, {"days": 3651}, {"days": "x"}, {"days": 5, "other": 1}):
        assert owner.patch(URL, json=body).status_code == 422, body
    owner.patch(URL, json={"days": 7})
    reader = owner.pat("recordings:read")
    assert reader.get(URL).json()["days"] == 7
    assert reader.patch(URL, json={"days": 8}).status_code == 403
    assert owner.pat("people:read").get(URL).status_code == 403


def test_purge_removes_only_the_audio_of_due_recordings(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], services: Services
):
    off, on = as_user(make_user()), as_user(make_user())
    kept = transcribed(off, services.settings)
    old = transcribed(on, services.settings)
    key = _audio_key(services, old["id"])
    assert key is not None
    on.patch(URL, json={"days": 30})

    assert _purge(services, datetime.now(UTC) + timedelta(days=10)) == 0
    assert _audio_key(services, old["id"]) == key

    assert _purge(services, datetime.now(UTC) + timedelta(days=40)) >= 1
    assert _audio_key(services, old["id"]) is None
    assert _audio_key(services, kept["id"]) is not None
    drain_storage(services.settings)
    assert _object_count(services, key) == 0

    body = on.get(f"/api/v1/recordings/{old['id']}").json()
    assert body["audio_deleted_at"] is not None
    assert body["transcript_id"] == old["transcript_id"]
    assert on.get(f"/api/v1/transcripts/{old['transcript_id']}").status_code == 200
    assert off.get(f"/api/v1/recordings/{kept['id']}").json()["audio_deleted_at"] is None
    # A second run finds nothing left to delete for this recording.
    assert _purge(services, datetime.now(UTC) + timedelta(days=41)) == 0


def test_ceiling_does_not_delete_for_an_account_that_left_it_off(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], admin: Api, services: Services
):
    owner = as_user(make_user())
    recording = upload_file(owner, audio_bytes(4601))
    assert admin.patch(ADMIN, json={"retention": {"audio_max_days": 1}}).status_code == 200
    _purge(services, datetime.now(UTC) + timedelta(days=400))
    assert _audio_key(services, recording["id"]) is not None
    assert admin.patch(ADMIN, json={"retention": {"audio_max_days": None}}).status_code == 200


def test_a_recording_with_an_open_job_is_skipped(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], services: Services
):
    owner = as_user(make_user())
    owner.patch(URL, json={"days": 1})
    recording = upload_file(owner, audio_bytes(4602))
    assert recording["status"] in {"queued", "processing"}
    _purge(services, datetime.now(UTC) + timedelta(days=10))
    assert _audio_key(services, recording["id"]) is not None


def test_a_recording_without_audio_answers_410_and_refuses_retranscription(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], services: Services
):
    owner = as_user(make_user())
    recording = transcribed(owner, services.settings)
    redirect = owner.get(f"/api/v1/recordings/{recording['id']}/audio", follow_redirects=False)
    location = redirect.headers["location"]
    owner.patch(URL, json={"days": 1})
    _purge(services, datetime.now(UTC) + timedelta(days=5))

    gone = owner.get(f"/api/v1/recordings/{recording['id']}/audio", follow_redirects=False)
    assert gone.status_code == 410
    assert gone.json()["code"] == "audio_deleted"
    signed = owner.client.get(location)
    assert signed.status_code == 410
    assert signed.json()["code"] == "audio_deleted"

    again = owner.post(f"/api/v1/recordings/{recording['id']}/retranscribe")
    assert again.status_code == 409
    assert again.json()["code"] == "audio_deleted"


def test_no_voice_sample_from_a_recording_without_audio(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], admin: Api, services: Services
):
    assert admin.patch(ADMIN, json={"voice_identification": {"enabled": True}}).status_code == 200
    owner = as_user(make_user())
    person = owner.post("/api/v1/people", json={"name": "Person One"}).json()
    kept = transcribed(owner, services.settings)
    gone = transcribed(owner, services.settings)
    _sql(
        services,
        "UPDATE recordings SET audio_key = NULL, audio_deleted_at = now() WHERE id = :r",
        r=gone["id"],
    )
    for recording in (gone, kept):
        link = owner.patch(
            f"/api/v1/transcripts/{recording['transcript_id']}/speakers/S2", json={"person_id": person["id"]}
        )
        assert link.status_code == 200, link.text
    assert owner.get(f"/api/v1/people/{person['id']}/voiceprint").json()["sample_count"] == 1
