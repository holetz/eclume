"""Voice identification: platform on/off switch, suggestion, confirmation, rejection, LGPD and isolation."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text

from eclume_server.voice import DEFAULT_THRESHOLD
from eclume_server_testing.api import agenda_types, audio_bytes, upload_file
from eclume_server_testing.fakes import (
    DEFAULT_VOICES,
    contract_transcript,
    drain_storage,
    run_cpu,
    run_gpu,
    transcribed,
    voice,
)
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services


def _sql(services: Services, sql: str, **params: Any) -> list[tuple[Any, ...]]:  # noqa: ANN401
    async def go(conn: Any) -> list[tuple[Any, ...]]:  # noqa: ANN401
        result = await conn.execute(text(sql), params)
        return [tuple(row) for row in result] if result.returns_rows else []

    return run(services.sql(go))


class VoiceAccount:
    """A test user account, with the platform admin session and voice helpers."""

    def __init__(self, services: Services, admin: Api, owner: Account, owner_api: Api) -> None:
        """Platform admin and the owner of the recordings."""
        self.services, self.admin, self.owner, self.owner_id = services, admin, owner_api, owner.user_id
        # The suggestion tests start with automatic assignment off; its own tests turn it on.
        self.auto(enabled=False)

    def voice_on(self, *, enabled: bool = True) -> None:
        """Turn voice identification on (or off) for the platform, as the admin."""
        response = self.admin.patch("/api/v1/admin/settings", json={"voice_identification": {"enabled": enabled}})
        assert response.status_code == 200, response.text

    def auto(self, *, enabled: bool | None = None, threshold: float | None = None) -> dict[str, Any]:
        """Change the automatic assignment of the owner's account."""
        body = {k: v for k, v in {"enabled": enabled, "threshold": threshold}.items() if v is not None}
        response = self.owner.patch("/api/v1/me/voice-assignment", json=body)
        assert response.status_code == 200, response.text
        return response.json()

    def person(self, name: str) -> dict[str, Any]:
        """Create the person."""
        return self.owner.post("/api/v1/people", json={"name": name}).json()

    def transcript(self, voices: dict[str, list[float]] | None = None) -> str:
        """A transcribed recording of the owner; returns the transcript id."""
        recording = transcribed(self.owner, self.services.settings, voices=voices)
        return recording["transcript_id"]

    def link(self, tid: str, speaker: str, person_id: str | None) -> dict[str, Any]:
        """Link (or unlink, with `None`) the speaker to the person."""
        response = self.owner.patch(f"/api/v1/transcripts/{tid}/speakers/{speaker}", json={"person_id": person_id})
        assert response.status_code == 200, response.text
        return response.json()

    def speakers(self, tid: str) -> dict[str, dict[str, Any]]:
        """The transcript's speakers by id."""
        return {s["id"]: s for s in self.owner.get(f"/api/v1/transcripts/{tid}").json()["speakers"]}

    def samples(self, person_id: str) -> int:
        """Samples in the person's voiceprint."""
        return self.owner.get(f"/api/v1/people/{person_id}/voiceprint").json()["sample_count"]


@pytest.fixture
def new_account(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
) -> Callable[[], VoiceAccount]:
    def make() -> VoiceAccount:
        owner = make_user()
        return VoiceAccount(services, admin, owner, as_user(owner))

    return make


@pytest.fixture
def account(new_account: Callable[[], VoiceAccount]) -> VoiceAccount:
    return new_account()


def test_off_nothing_is_compared_or_kept(account: VoiceAccount, services: Services):
    rafael = account.person("Rafael Lima")
    first = account.transcript()
    account.link(first, "S2", rafael["id"])
    assert account.samples(rafael["id"]) == 0
    second = account.transcript()
    assert all(s["suggestions"] == [] for s in account.speakers(second).values())
    assert _sql(services, "SELECT count(*) FROM speaker_embeddings WHERE transcript_id = :t", t=second) == [(0,)]
    settings = account.admin.get("/api/v1/admin/settings").json()["voice_identification"]
    assert settings == {"enabled": False, "suggestion_threshold": DEFAULT_THRESHOLD}
    voiceprint = account.owner.get(f"/api/v1/people/{rafael['id']}/voiceprint").json()
    assert voiceprint == {"person_id": rafael["id"], "enabled": False, "sample_count": 0, "samples": []}


def test_on_confirmation_becomes_sample_without_per_person_consent(account: VoiceAccount):
    account.voice_on()
    rafael = account.person("Rafael Lima")
    account.link(account.transcript(), "S2", rafael["id"])
    # Accepting the notice at signup covers the consent of whoever the user records.
    voiceprint = account.owner.get(f"/api/v1/people/{rafael['id']}/voiceprint").json()
    assert (voiceprint["enabled"], voiceprint["sample_count"]) == (True, 1)
    assert "voice_consent" not in account.owner.get(f"/api/v1/people/{rafael['id']}").json()


def test_suggests_above_threshold_and_confirmation_reinforces(account: VoiceAccount):
    account.voice_on()
    rafael = account.person("Rafael Lima")
    account.link(account.transcript(), "S2", rafael["id"])
    assert account.samples(rafael["id"]) == 1

    # The same voice with noise, in another meeting: suggested, never linked.
    close = dict(DEFAULT_VOICES, S2=voice(2, jitter=0.5, jitter_seed=1))
    second = account.transcript(close)
    speakers = account.speakers(second)
    assert speakers["S2"]["person"] is None
    [suggestion] = speakers["S2"]["suggestions"]
    assert suggestion["person"] == {"id": rafael["id"], "name": "Rafael Lima"}
    assert DEFAULT_THRESHOLD <= suggestion["score"] <= 1
    assert speakers["S1"]["suggestions"] == speakers["S3"]["suggestions"] == []

    accepted = account.link(second, "S2", rafael["id"])
    assert (accepted["person"]["name"], accepted["suggestions"]) == ("Rafael Lima", [])
    assert account.samples(rafael["id"]) == 2

    # A different voice: below the threshold, no suggestion.
    far = dict(DEFAULT_VOICES, S2=voice(99))
    assert account.speakers(account.transcript(far))["S2"]["suggestions"] == []


def test_suggestions_in_score_order(account: VoiceAccount):
    account.voice_on()
    rafael, juliana = account.person("Rafael Lima"), account.person("Juliana Prado")
    first = account.transcript()
    account.link(first, "S2", rafael["id"])
    account.link(first, "S3", juliana["id"])
    # S2 of the new meeting sounds like both; more like Rafael.
    mixed = [a + 0.8 * b for a, b in zip(DEFAULT_VOICES["S2"], DEFAULT_VOICES["S3"], strict=True)]
    second = account.transcript(dict(DEFAULT_VOICES, S2=mixed, S3=voice(50)))
    suggestions = account.speakers(second)["S2"]["suggestions"]
    assert [s["person"]["name"] for s in suggestions] == ["Rafael Lima", "Juliana Prado"]
    assert suggestions[0]["score"] > suggestions[1]["score"]
    # Once linked, the speaker shows no more suggestions.
    assert account.link(second, "S2", juliana["id"])["suggestions"] == []


def test_off_hides_the_suggestions(account: VoiceAccount):
    account.voice_on()
    rafael = account.person("Rafael Lima")
    account.link(account.transcript(), "S2", rafael["id"])
    second = account.transcript()
    assert account.speakers(second)["S2"]["suggestions"]
    account.voice_on(enabled=False)
    assert account.speakers(second)["S2"]["suggestions"] == []


def test_reject_suggestion(account: VoiceAccount):
    account.voice_on()
    rafael = account.person("Rafael Lima")
    account.link(account.transcript(), "S2", rafael["id"])
    second = account.transcript()
    base = f"/api/v1/transcripts/{second}"
    revision = account.owner.get(base).json()["revision"]
    url = f"{base}/speakers/S2/suggestions/{rafael['id']}"

    assert account.owner.pat("transcripts:write").delete(url).status_code == 403
    # The admin session is not a user credential.
    assert account.admin.delete(url).status_code == 401
    rejected = account.owner.delete(url)
    assert rejected.status_code == 200, rejected.text
    assert (rejected.json()["id"], rejected.json()["suggestions"]) == ("S2", [])
    assert account.owner.get(base).json()["revision"] == revision + 1
    assert account.owner.delete(url).status_code == 404
    assert account.speakers(second)["S2"]["suggestions"] == []
    assert account.samples(rafael["id"]) == 1


def test_unlink_and_relink_remove_the_contribution(account: VoiceAccount):
    account.voice_on()
    rafael, juliana = account.person("Rafael Lima"), account.person("Juliana Prado")
    tid = account.transcript()
    account.link(tid, "S2", rafael["id"])
    assert account.samples(rafael["id"]) == 1
    account.link(tid, "S2", None)
    assert account.samples(rafael["id"]) == 0
    account.link(tid, "S2", rafael["id"])
    account.link(tid, "S2", juliana["id"])
    assert (account.samples(rafael["id"]), account.samples(juliana["id"])) == (0, 1)
    # Merging takes away the sample of the speaker that disappears.
    account.owner.post(
        f"/api/v1/transcripts/{tid}/speakers/merge", json={"source_speaker_ids": ["S2"], "target_speaker_id": "S1"}
    )
    assert account.samples(juliana["id"]) == 0


def test_forget_voice_deletes_samples_and_suggestions(account: VoiceAccount):
    account.voice_on()
    rafael = account.person("Rafael Lima")
    account.link(account.transcript(), "S2", rafael["id"])
    account.link(account.transcript(), "S2", rafael["id"])
    second = account.transcript()
    assert account.speakers(second)["S2"]["suggestions"]
    assert account.samples(rafael["id"]) == 2
    voiceprint = account.owner.get(f"/api/v1/people/{rafael['id']}/voiceprint").json()
    assert {s["speaker_id"] for s in voiceprint["samples"]} == {"S2"}
    assert all("embedding" not in s for s in voiceprint["samples"])
    assert all(s["recording_title"] for s in voiceprint["samples"])

    url = f"/api/v1/people/{rafael['id']}/voiceprint"
    assert account.owner.pat("people:write").delete(url).status_code == 403
    assert account.owner.delete(url).status_code == 204
    assert account.samples(rafael["id"]) == 0
    assert account.speakers(second)["S2"]["suggestions"] == []
    # The person stays; only their voice goes.
    assert account.owner.get(f"/api/v1/people/{rafael['id']}").status_code == 200


def test_forget_voice_deletes_the_linked_speakers_vectors(account: VoiceAccount, services: Services):
    account.voice_on()
    rafael = account.person("Rafael Lima")
    linked, other = account.transcript(), account.transcript()
    account.link(linked, "S2", rafael["id"])
    assert _embeddings(services, linked) == 3
    assert account.owner.delete(f"/api/v1/people/{rafael['id']}/voiceprint").status_code == 204
    # The vector of the speaker linked to the person goes; the link and the other speakers stay.
    assert _embeddings(services, linked) == 2
    assert _embeddings(services, other) == 3
    assert account.speakers(linked)["S2"]["person"]["id"] == rafael["id"]
    # Relinking the same speaker does not recreate the sample: the vector no longer exists.
    account.link(linked, "S2", None)
    account.link(linked, "S2", rafael["id"])
    assert account.samples(rafael["id"]) == 0


def test_remove_one_sample_and_play_the_excerpt(new_account: Callable[[], VoiceAccount]):
    account, other = new_account(), new_account()
    account.voice_on()
    rafael = account.person("Rafael Lima")
    first, second = account.transcript(), account.transcript()
    account.link(first, "S2", rafael["id"])
    account.link(second, "S2", rafael["id"])
    assert account.owner.get(f"/api/v1/people/{rafael['id']}").json()["voice_sample_count"] == 2

    # Each sample names the recording and the speaker's longest utterance, to play it in the audio.
    longest = max(
        (s for s in contract_transcript()["segments"] if s["speaker_id"] == "S2"),
        key=lambda s: s["end_ms"] - s["start_ms"],
    )
    samples = account.owner.get(f"/api/v1/people/{rafael['id']}/voiceprint").json()["samples"]
    by_transcript = {sample["transcript_id"]: sample for sample in samples}
    first_recording = account.owner.get(f"/api/v1/transcripts/{first}").json()["recording_id"]
    assert by_transcript[first]["recording_id"] == first_recording
    assert by_transcript[first]["excerpt"] == {"start_ms": longest["start_ms"], "end_ms": longest["end_ms"]}

    url = f"/api/v1/people/{rafael['id']}/voice-samples/{first}/S2"
    # Biometric data: only the session removes it, and one account's sample does not exist for another.
    assert account.owner.pat("people:write").delete(url).status_code == 403
    assert other.owner.delete(url).status_code == 404
    assert account.owner.delete(url).status_code == 204
    assert account.owner.delete(url).status_code == 404
    assert account.samples(rafael["id"]) == 1
    remaining = account.owner.get(f"/api/v1/people/{rafael['id']}/voiceprint").json()["samples"]
    assert [sample["transcript_id"] for sample in remaining] == [second]
    # The speaker stays linked: only the sample left the voiceprint.
    assert account.speakers(first)["S2"]["person"]["id"] == rafael["id"]
    assert account.owner.get(f"/api/v1/people/{rafael['id']}").json()["voice_sample_count"] == 1


def test_other_account_is_never_compared(new_account: Callable[[], VoiceAccount], services: Services):
    account, other = new_account(), new_account()
    account.voice_on()
    stranger = other.person("Pessoa de fora")
    other.link(other.transcript(), "S2", stranger["id"])
    assert other.samples(stranger["id"]) == 1
    # The same voice in the other organization's account: no suggestion, no read, no deletion.
    assert all(s["suggestions"] == [] for s in account.speakers(account.transcript()).values())
    assert account.owner.get(f"/api/v1/people/{stranger['id']}/voiceprint").status_code == 404
    assert account.owner.delete(f"/api/v1/people/{stranger['id']}/voiceprint").status_code == 404
    assert other.samples(stranger["id"]) == 1

    async def as_app(conn: Any) -> list[int]:  # noqa: ANN401
        await conn.execute(text("SET LOCAL ROLE eclume_app"))
        await conn.execute(text("SELECT set_config('app.user_id', :user, true)"), {"user": str(account.owner_id)})
        sql = "SELECT count(*) FROM {} WHERE person_id = :p"
        return [
            (await conn.execute(text(sql.format(table)), {"p": stranger["id"]})).scalar()
            for table in ("voice_samples", "speaker_suggestions")
        ]

    assert run(services.sql(as_app)) == [0, 0]
    assert _sql(services, "SELECT count(*) FROM voice_samples WHERE person_id = :p", p=stranger["id"]) == [(1,)]


def test_retranscription_restores_the_links(account: VoiceAccount, services: Services):
    account.voice_on()
    rafael, mariana = account.person("Rafael Lima"), account.person("Mariana Couto")
    recording = transcribed(account.owner, services.settings)
    tid = recording["transcript_id"]
    account.link(tid, "S2", rafael["id"])
    account.link(tid, "S1", mariana["id"])
    assert account.samples(rafael["id"]) == 1

    response = account.owner.post(f"/api/v1/recordings/{recording['id']}/retranscribe", json={})
    assert response.status_code in {200, 202}, response.text
    run_gpu(services.settings)
    run_cpu(services.settings)
    speakers = account.speakers(tid)
    assert (speakers["S2"]["person"]["id"], speakers["S2"]["label"]) == (rafael["id"], "Rafael Lima")
    assert speakers["S1"]["person"]["id"] == mariana["id"]
    assert speakers["S3"]["person"] is None
    assert account.samples(rafael["id"]) == 1
    assert account.samples(mariana["id"]) == 1
    assert _sql(
        services,
        "SELECT count(*) FROM voice_samples s LEFT JOIN speakers sp USING (transcript_id, speaker_id) WHERE sp.person_id IS NULL",
    ) == [(0,)]


# --- LGPD: per-recording embeddings purge and full deletion ------------------------------------


def _recording_of(services: Services, tid: str) -> str:
    return str(_sql(services, "SELECT recording_id FROM transcripts WHERE id = :t", t=tid)[0][0])


def _objects(services: Services, prefix: str) -> list[str]:
    listed = services.s3().list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=prefix)
    return [obj["Key"] for obj in listed.get("Contents", [])]


def _embeddings(services: Services, tid: str) -> int:
    return _sql(services, "SELECT count(*) FROM speaker_embeddings WHERE transcript_id = :t", t=tid)[0][0]


def test_turning_off_purges_embeddings_platform_wide(
    account: VoiceAccount, new_account: Callable[[], VoiceAccount], services: Services
):
    other = new_account()
    account.voice_on()
    rafael = account.person("Rafael Lima")
    account.link(account.transcript(), "S2", rafael["id"])
    tid = account.transcript()
    assert account.speakers(tid)["S2"]["suggestions"]
    other_tid = other.transcript()
    rid, other_rid = _recording_of(services, tid), _recording_of(services, other_tid)
    embeddings_key = f"recordings/{rid}/r1/speaker_embeddings.json"
    assert _embeddings(services, tid) == 3
    assert _objects(services, embeddings_key) == [embeddings_key]
    # An old key, without a revision, from before per-revision artifacts.
    legacy_key = f"recordings/{other_rid}/speaker_embeddings.json"
    services.s3().put_object(Bucket=services.settings.s3_bucket, Key=legacy_key, Body=b"{}")

    account.voice_on(enabled=False)
    # Turning off applies to every account: per-recording embeddings and pending suggestions go.
    assert _embeddings(services, tid) == _embeddings(services, other_tid) == 0
    assert _sql(services, "SELECT count(*) FROM speaker_suggestions WHERE status = 'pending'") == [(0,)]
    # The samples (confirmed speakers) stay; forgetting a voice goes through the person.
    assert account.samples(rafael["id"]) == 1

    run_cpu(services.settings)
    assert _objects(services, embeddings_key) == []
    assert _objects(services, f"recordings/{rid}/r1/transcript.raw.json")  # only the embeddings go
    assert _objects(services, legacy_key) == []
    assert [key for key in _objects(services, "recordings/") if key.endswith("/speaker_embeddings.json")] == []


def test_embeddings_leave_the_bucket_after_ingest(account: VoiceAccount, services: Services):
    account.voice_on()
    tid = account.transcript()
    rid = _recording_of(services, tid)
    key = f"recordings/{rid}/r1/speaker_embeddings.json"
    assert _embeddings(services, tid) == 3
    # In the deletion queue since the ingest transaction; the vector stays only in the database.
    assert _sql(services, "SELECT count(*) FROM storage_deletions WHERE key = :k", k=key) == [(1,)]
    drain_storage(services.settings)
    assert _objects(services, key) == []
    assert _objects(services, f"recordings/{rid}/r1/transcript.raw.json")
    assert _embeddings(services, tid) == 3


def test_ingest_with_voice_turned_off_midway_keeps_no_embeddings(account: VoiceAccount, services: Services):
    account.voice_on()
    recording = upload_file(account.owner, audio_bytes(2100))
    job = _sql(
        services, "SELECT options ->> 'embeddings' FROM transcription_jobs WHERE recording_id = :r", r=recording["id"]
    )
    assert job == [("true",)]
    account.voice_on(enabled=False)
    run_gpu(services.settings)
    run_cpu(services.settings)
    tid = account.owner.get(f"/api/v1/recordings/{recording['id']}").json()["transcript_id"]
    assert _embeddings(services, tid) == 0
    assert _objects(services, f"recordings/{recording['id']}/r1/transcript.raw.json")
    drain_storage(services.settings)
    assert _objects(services, f"recordings/{recording['id']}/r1/speaker_embeddings.json") == []


def test_delete_recording_deletes_audio_transcript_embeddings_samples_and_summaries(
    account: VoiceAccount, services: Services
):
    account.voice_on()
    rafael = account.person("Rafael Lima")
    tid = account.transcript()
    account.link(tid, "S2", rafael["id"])
    account.admin.post(
        "/api/v1/admin/agent-providers", json={"name": "Claude", "kind": "claude-cli", "model": "sonnet"}
    )
    agenda_type_id = str(agenda_types(services, account.owner_id)[0]["id"])
    summary = account.owner.post(f"/api/v1/transcripts/{tid}/summaries", json={"agenda_type_id": agenda_type_id})
    assert summary.status_code == 202, summary.text
    run_cpu(services.settings)
    rid = _recording_of(services, tid)
    audio_key = _sql(services, "SELECT audio_key FROM recordings WHERE id = :r", r=rid)[0][0]
    counts = """
        SELECT (SELECT count(*) FROM transcripts WHERE id = :t),
               (SELECT count(*) FROM segments WHERE transcript_id = :t),
               (SELECT count(*) FROM speakers WHERE transcript_id = :t),
               (SELECT count(*) FROM speaker_embeddings WHERE transcript_id = :t),
               (SELECT count(*) FROM voice_samples WHERE transcript_id = :t),
               (SELECT count(*) FROM summaries WHERE transcript_id = :t),
               (SELECT count(*) FROM transcription_jobs WHERE recording_id = :r)
    """
    assert all(n > 0 for n in _sql(services, counts, t=tid, r=rid)[0])
    assert _objects(services, audio_key)
    assert len(_objects(services, f"recordings/{rid}/")) == 2  # raw transcript and embeddings

    assert account.owner.delete(f"/api/v1/recordings/{rid}").status_code == 204
    assert _sql(services, counts, t=tid, r=rid) == [(0, 0, 0, 0, 0, 0, 0)]
    # The objects go through the deletion queue, on drain.
    drain_storage(services.settings)
    assert _objects(services, audio_key) == []
    assert _objects(services, f"recordings/{rid}/") == []


# --- account without voice samples (holetz/eclume#116) ------------------------------------------


def _keep(account: VoiceAccount, *, keep: bool) -> dict[str, Any]:
    response = account.owner.patch("/api/v1/me/voice-assignment", json={"keep_samples": keep})
    assert response.status_code == 200, response.text
    return response.json()


def _embedding_objects(services: Services, rid: str) -> list[str]:
    return [key for key in _objects(services, f"recordings/{rid}/") if key.endswith("/speaker_embeddings.json")]


def test_stop_keeping_deletes_only_this_accounts_voice(
    account: VoiceAccount, new_account: Callable[[], VoiceAccount], services: Services
):
    other = new_account()
    account.voice_on()
    rafael, ana = account.person("Rafael Lima"), account.person("Ana Souza")
    first = account.transcript()
    account.link(first, "S2", rafael["id"])
    account.link(first, "S3", ana["id"])
    tid = account.transcript()
    assert account.speakers(tid)["S2"]["suggestions"]
    other_tid = other.transcript()
    rid, other_rid = _recording_of(services, tid), _recording_of(services, other_tid)
    before = account.owner.get("/api/v1/me/voice-assignment").json()
    assert (before["keep_samples"], before["sample_count"], before["voiceprint_people"]) == (True, 2, 2)

    after = _keep(account, keep=False)
    assert (after["keep_samples"], after["sample_count"], after["voiceprint_people"]) == (False, 0, 0)
    owner = {"o": account.owner_id}
    for table in ("speaker_embeddings", "voice_samples"):
        assert _sql(services, f"SELECT count(*) FROM {table} WHERE owner_id = :o", **owner) == [(0,)]  # noqa: S608
    pending = "SELECT count(*) FROM speaker_suggestions WHERE owner_id = :o AND status = 'pending'"
    assert _sql(services, pending, **owner) == [(0,)]
    assert account.speakers(tid)["S2"]["suggestions"] == []
    # The confirmed link stays; only the biometrics go.
    assert account.speakers(first)["S2"]["person"]["id"] == rafael["id"]
    # The other account loses nothing.
    assert _embeddings(services, other_tid) == 3

    run_cpu(services.settings)
    assert _embedding_objects(services, rid) == []
    assert _objects(services, f"recordings/{rid}/r1/transcript.raw.json")
    assert _embedding_objects(services, other_rid)
    # Turning off again deletes nothing more; turning back on does not recover what left.
    assert _keep(account, keep=False)["sample_count"] == 0
    assert _keep(account, keep=True)["sample_count"] == 0


def test_account_without_samples_nothing_is_computed_compared_or_kept(account: VoiceAccount, services: Services):
    account.voice_on()
    account.auto(enabled=True)
    rafael = account.person("Rafael Lima")
    _keep(account, keep=False)
    recording = upload_file(account.owner, audio_bytes(2100))
    job = _sql(
        services, "SELECT options ->> 'embeddings' FROM transcription_jobs WHERE recording_id = :r", r=recording["id"]
    )
    assert job == [("false",)]
    run_gpu(services.settings)
    run_cpu(services.settings)
    first = account.owner.get(f"/api/v1/recordings/{recording['id']}").json()["transcript_id"]
    assert _embeddings(services, first) == 0
    account.link(first, "S2", rafael["id"])
    assert account.samples(rafael["id"]) == 0
    second = account.transcript()
    assert _embeddings(services, second) == 0
    assert all(s["suggestions"] == [] and s["person"] is None for s in account.speakers(second).values())


def test_job_from_before_stop_keeping_does_not_keep_the_vector(account: VoiceAccount, services: Services):
    account.voice_on()
    recording = upload_file(account.owner, audio_bytes(2100))
    job = _sql(
        services, "SELECT options ->> 'embeddings' FROM transcription_jobs WHERE recording_id = :r", r=recording["id"]
    )
    assert job == [("true",)]
    _keep(account, keep=False)
    run_gpu(services.settings)
    run_cpu(services.settings)
    tid = account.owner.get(f"/api/v1/recordings/{recording['id']}").json()["transcript_id"]
    assert _embeddings(services, tid) == 0
    drain_storage(services.settings)
    assert _embedding_objects(services, recording["id"]) == []


def test_keeping_again_applies_to_the_next_ones(account: VoiceAccount, services: Services):
    account.voice_on()
    _keep(account, keep=False)
    _keep(account, keep=True)
    assert _embeddings(services, account.transcript()) == 3


# --- automatic speaker assignment -------------------------------------------------------------------


def test_automatic_assignment_default_and_account_threshold(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], admin: Api
):
    owner = as_user(make_user())
    counts = {"keep_samples": True, "sample_count": 0, "voiceprint_people": 0}
    assert owner.get("/api/v1/me/voice-assignment").json() == {
        "enabled": True,
        "threshold": 0.75,
        "platform_enabled": False,
        **counts,
    }
    admin.patch("/api/v1/admin/settings", json={"voice_identification": {"enabled": True}})
    assert owner.patch("/api/v1/me/voice-assignment", json={"threshold": 0.9}).json() == {
        "enabled": True,
        "threshold": 0.9,
        "platform_enabled": True,
        **counts,
    }
    assert owner.patch("/api/v1/me/voice-assignment", json={"enabled": False}).json()["threshold"] == 0.9
    for body in ({}, {"threshold": 0.3}, {"threshold": 1}, {"enabled": None}, {"keep_samples": None}, {"outro": 1}):
        assert owner.patch("/api/v1/me/voice-assignment", json=body).status_code == 422, body


def test_similar_voice_links_speaker_and_summary_already_uses_name(account: VoiceAccount):
    account.voice_on()
    rafael = account.person("Rafael Lima")
    account.link(account.transcript(), "S2", rafael["id"])
    account.auto(enabled=True, threshold=0.7)

    second = account.transcript(dict(DEFAULT_VOICES, S2=voice(2, jitter=0.3, jitter_seed=1)))
    speakers = account.speakers(second)
    assert (speakers["S2"]["person"], speakers["S2"]["label"]) == (
        {"id": rafael["id"], "name": "Rafael Lima"},
        "Rafael Lima",
    )
    assert 0.7 <= speakers["S2"]["auto_score"] <= 1
    assert speakers["S2"]["suggestions"] == []
    assert speakers["S1"]["auto_score"] is None
    assert speakers["S1"]["person"] is None
    # An automatic link does not reinforce the voiceprint: only confirmation does.
    assert account.samples(rafael["id"]) == 1

    confirmed = account.link(second, "S2", rafael["id"])
    assert (confirmed["person"]["name"], confirmed["auto_score"]) == ("Rafael Lima", None)
    assert account.samples(rafael["id"]) == 2


def test_undoing_automatic_assignment_rejects_the_person(account: VoiceAccount):
    account.voice_on()
    rafael = account.person("Rafael Lima")
    account.link(account.transcript(), "S2", rafael["id"])
    account.auto(enabled=True, threshold=0.7)
    second = account.transcript(dict(DEFAULT_VOICES, S2=voice(2, jitter=0.3, jitter_seed=1)))
    assert account.speakers(second)["S2"]["auto_score"] is not None
    undone = account.link(second, "S2", None)
    assert (undone["person"], undone["auto_score"]) == (None, None)


def test_high_threshold_or_account_off_only_suggests(account: VoiceAccount):
    account.voice_on()
    rafael = account.person("Rafael Lima")
    account.link(account.transcript(), "S2", rafael["id"])
    close = dict(DEFAULT_VOICES, S2=voice(2, jitter=0.5, jitter_seed=1))

    account.auto(enabled=True, threshold=0.99)
    high = account.speakers(account.transcript(close))["S2"]
    assert (high["person"], high["auto_score"]) == (None, None)
    assert [s["person"]["name"] for s in high["suggestions"]] == ["Rafael Lima"]

    account.auto(enabled=True, threshold=0.5)
    account.auto(enabled=False)
    off = account.speakers(account.transcript(close))["S2"]
    assert (off["person"], off["auto_score"]) == (None, None)
    assert len(off["suggestions"]) == 1


def test_platform_off_nothing_is_assigned(account: VoiceAccount):
    account.voice_on()
    rafael = account.person("Rafael Lima")
    account.link(account.transcript(), "S2", rafael["id"])
    account.auto(enabled=True, threshold=0.5)
    account.voice_on(enabled=False)
    speaker = account.speakers(account.transcript())["S2"]
    assert (speaker["person"], speaker["auto_score"]) == (None, None)


def test_two_people_with_similar_voices_are_not_assigned(account: VoiceAccount):
    account.voice_on()
    rafael, juliana = account.person("Rafael Lima"), account.person("Juliana Prado")
    twins = dict(DEFAULT_VOICES, S3=voice(2, jitter=0.05, jitter_seed=3))
    first = account.transcript(twins)
    account.link(first, "S2", rafael["id"])
    account.link(first, "S3", juliana["id"])
    account.auto(enabled=True, threshold=0.5)
    # With no margin between the two candidates, the speaker is linked to neither: it only suggests both.
    second = account.speakers(account.transcript())["S2"]
    assert (second["person"], second["auto_score"]) == (None, None)
    assert {s["person"]["name"] for s in second["suggestions"]} == {"Rafael Lima", "Juliana Prado"}


def test_retranscription_keeps_the_automatic_link_without_becoming_sample(account: VoiceAccount, services: Services):
    account.voice_on()
    rafael = account.person("Rafael Lima")
    account.link(account.transcript(), "S2", rafael["id"])
    account.auto(enabled=True, threshold=0.7)
    recording = transcribed(
        account.owner, services.settings, voices=dict(DEFAULT_VOICES, S2=voice(2, jitter=0.3, jitter_seed=1))
    )
    tid = recording["transcript_id"]
    assert account.speakers(tid)["S2"]["auto_score"] is not None

    response = account.owner.post(f"/api/v1/recordings/{recording['id']}/retranscribe", json={})
    assert response.status_code in {200, 202}, response.text
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert account.speakers(tid)["S2"]["person"]["id"] == rafael["id"]
    assert account.samples(rafael["id"]) == 1
