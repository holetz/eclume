"""Transcription language per account and per file (holetz/eclume#121)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import run_cpu, run_gpu

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services


_sizes = iter(range(100, 10_000))


def _job_language(api: Api, services: Services, **fields: str) -> str | None:
    """Upload a new audio file (no dedup), transcribe it and return the language the job carried to the GPU worker."""
    upload_file(api, audio_bytes(next(_sizes)), **fields)
    calls = run_gpu(services.settings)
    run_cpu(services.settings)
    assert len(calls) == 1, calls
    return calls[0][2]["language"]


def test_account_preference_starts_at_the_server_default(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], admin: Api
):
    owner = as_user(make_user())
    assert owner.get("/api/v1/me/transcription").json() == {"language": None, "platform_default": "pt"}
    admin.patch("/api/v1/admin/settings", json={"asr": {"default_language": "en"}})
    assert owner.get("/api/v1/me/transcription").json() == {"language": None, "platform_default": "en"}
    assert owner.patch("/api/v1/me/transcription", json={"language": "es"}).json() == {
        "language": "es",
        "platform_default": "en",
    }
    assert owner.patch("/api/v1/me/transcription", json={"language": "auto"}).json()["language"] == "auto"
    assert owner.patch("/api/v1/me/transcription", json={"language": None}).json()["language"] is None
    for body in ({}, {"language": "português"}, {"language": "pt", "outro": 1}):
        assert owner.patch("/api/v1/me/transcription", json=body).status_code == 422, body


def test_pat_reads_the_preference_but_does_not_write_it(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api]
):
    owner = as_user(make_user())
    owner.patch("/api/v1/me/transcription", json={"language": "en"})
    reader = owner.pat("recordings:read")
    assert reader.get("/api/v1/me/transcription").json()["language"] == "en"
    assert reader.patch("/api/v1/me/transcription", json={"language": "pt"}).status_code == 403
    assert owner.pat("people:read").get("/api/v1/me/transcription").status_code == 403


def test_job_language_comes_from_the_file_the_account_and_the_server(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], admin: Api, services: Services
):
    owner = as_user(make_user())
    assert _job_language(owner, services) == "pt"
    admin.patch("/api/v1/admin/settings", json={"asr": {"default_language": "en"}})
    assert _job_language(owner, services) == "en"
    owner.patch("/api/v1/me/transcription", json={"language": "es"})
    assert _job_language(owner, services) == "es"
    assert _job_language(owner, services, language="pt-BR") == "pt"
    owner.patch("/api/v1/me/transcription", json={"language": "auto"})
    assert _job_language(owner, services) is None


def test_auto_on_the_file_stores_the_detected_language(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], services: Services
):
    owner = as_user(make_user())
    owner.patch("/api/v1/me/transcription", json={"language": "en"})
    recording = upload_file(owner, audio_bytes(1000), language="auto")
    assert recording["language"] == "auto"
    assert run_gpu(services.settings)[0][2]["language"] is None
    run_cpu(services.settings)
    # The engine fake detects `pt`; the recording never keeps `auto`.
    assert owner.get(f"/api/v1/recordings/{recording['id']}").json()["language"] == "pt"


def test_retranscribe_accepts_auto(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], services: Services
):
    owner = as_user(make_user())
    recording = upload_file(owner, audio_bytes(1000))
    run_gpu(services.settings)
    run_cpu(services.settings)
    again = owner.post(f"/api/v1/recordings/{recording['id']}/retranscribe", json={"language": "auto"})
    assert again.status_code == 202, again.text
    assert run_gpu(services.settings)[0][2]["language"] is None


def _speakers(calls: list) -> tuple[int | None, int | None]:
    options = calls[0][2]
    return options["min_speakers"], options["max_speakers"]


def test_voice_note_gets_one_speaker_and_the_meeting_gets_the_admin_limits(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], admin: Api, services: Services
):
    admin.patch("/api/v1/admin/settings", json={"diarization": {"min_speakers": 2, "max_speakers": 5}})
    owner = as_user(make_user())
    upload_file(owner, audio_bytes(next(_sizes)), kind="note")
    assert _speakers(run_gpu(services.settings)) == (1, 1)
    run_cpu(services.settings)
    upload_file(owner, audio_bytes(next(_sizes)))
    assert _speakers(run_gpu(services.settings)) == (2, 5)


def test_retranscribe_with_speakers_overrides_the_note_and_the_admin(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], services: Services
):
    owner = as_user(make_user())
    recording = upload_file(owner, audio_bytes(next(_sizes)), kind="note")
    run_gpu(services.settings)
    run_cpu(services.settings)
    url = f"/api/v1/recordings/{recording['id']}/retranscribe"
    assert owner.post(url, json={"min_speakers": 3, "max_speakers": 2}).status_code == 422
    assert owner.post(url, json={"min_speakers": 0}).status_code == 422
    assert owner.post(url, json={"min_speakers": 2, "max_speakers": 3}).status_code == 202
    assert _speakers(run_gpu(services.settings)) == (2, 3)


def test_retranscribe_with_one_speaker_side_keeps_the_platform_limit_on_the_other(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], admin: Api, services: Services
):
    admin.patch("/api/v1/admin/settings", json={"diarization": {"min_speakers": 2, "max_speakers": 4}})
    owner = as_user(make_user())
    recording = upload_file(owner, audio_bytes(next(_sizes)))
    run_gpu(services.settings)
    run_cpu(services.settings)
    url = f"/api/v1/recordings/{recording['id']}/retranscribe"
    for body, expected in (
        ({"min_speakers": 3}, (3, 4)),
        ({"max_speakers": 3}, (2, 3)),
        ({"min_speakers": 5}, (5, None)),
        ({"max_speakers": 1}, (None, 1)),
    ):
        assert owner.post(url, json=body).status_code == 202
        assert _speakers(run_gpu(services.settings)) == expected, body
        run_cpu(services.settings)


def test_retranscribe_rejects_speakers_above_the_cap_and_booleans(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], services: Services
):
    owner = as_user(make_user())
    recording = upload_file(owner, audio_bytes(next(_sizes)))
    run_gpu(services.settings)
    run_cpu(services.settings)
    url = f"/api/v1/recordings/{recording['id']}/retranscribe"
    for body in (
        {"min_speakers": 31},
        {"max_speakers": 31},
        {"min_speakers": 10**30},
        {"max_speakers": 256},
        {"min_speakers": True},
        {"max_speakers": False},
    ):
        assert owner.post(url, json=body).status_code == 422, body
    assert owner.post(url, json={"min_speakers": 30, "max_speakers": 30}).status_code == 202
