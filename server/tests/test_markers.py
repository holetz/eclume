"""Markers: alongside the upload (deduplicated included), idempotent batch, edit, deletion and isolation."""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from eclume_server_testing.api import audio_bytes, upload_file

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api

CAPTURE = {"meeting_app": "teams", "device_name": "NB-MARIANA", "client_version": "eclume-desktop/0.3.0"}


def _marker(at_ms: int, note: str | None = None, client_id: str | None = None) -> dict[str, Any]:
    return {"client_id": client_id or str(uuid4()), "at_ms": at_ms, "note": note}


def _markers(api: Api, recording_id: str) -> list[dict[str, Any]]:
    response = api.get(f"/api/v1/recordings/{recording_id}/markers")
    assert response.status_code == 200, response.text
    assert response.json()["next_cursor"] is None
    return response.json()["items"]


def test_markers_of_the_upload_and_of_the_deduplicated_upload(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    api = as_user(make_user())
    data = audio_bytes(100)
    decision, later = _marker(42_000, "Decisão sobre as turmas"), _marker(1_000)
    recording = upload_file(api, data, source="desktop", capture=CAPTURE, markers=[decision, later])
    assert recording["marker_count"] == 2
    listed = _markers(api, recording["id"])
    assert [(m["at_ms"], m["note"], m["device_name"]) for m in listed] == [
        (1_000, None, "NB-MARIANA"),
        (42_000, "Decisão sobre as turmas", "NB-MARIANA"),
    ]

    # The app crashed after uploading the audio and resends: the upload deduplicates and the markers do not repeat.
    body = {
        "filename": "reuniao.opus",
        "content_type": "audio/ogg; codecs=opus",
        "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "capture": CAPTURE,
        "markers": [decision | {"note": "Decisão: três turmas"}, later, _marker(90_000, "Fim")],
    }
    again = api.post("/api/v1/uploads", json=body)
    assert (again.status_code, again.json()["status"]) == (200, "deduplicated")
    listed = _markers(api, recording["id"])
    assert [(m["at_ms"], m["note"]) for m in listed] == [
        (1_000, None),
        (42_000, "Decisão: três turmas"),
        (90_000, "Fim"),
    ]
    assert api.get(f"/api/v1/recordings/{recording['id']}").json()["marker_count"] == 3


def test_idempotent_batch_edit_and_deletion(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    owner = as_user(make_user())
    recording = upload_file(owner, audio_bytes(100))
    url = f"/api/v1/recordings/{recording['id']}/markers"
    first = _marker(5_000, "Início")
    # Past the (still unknown) duration is accepted: the screen shows it at the end.
    batch = {"markers": [first, _marker(99_000_000)], "device_name": "iPhone 15 · Mariana"}
    posted = owner.post(url, json=batch)
    assert posted.status_code == 200, posted.text
    assert [m["device_name"] for m in posted.json()["items"]] == ["iPhone 15 · Mariana"] * 2
    again = owner.post(url, json={"markers": [first | {"note": "Começo"}]}).json()["items"]
    assert [(m["at_ms"], m["note"]) for m in again] == [(5_000, "Começo"), (99_000_000, None)]

    marker_id = again[0]["id"]
    patched = owner.patch(f"/api/v1/markers/{marker_id}", json={"note": None})
    assert (patched.status_code, patched.json()["note"]) == (200, None)
    # The note edited on the web survives an app resend without a note.
    owner.patch(f"/api/v1/markers/{marker_id}", json={"note": "Editada na web"})
    resent = owner.post(url, json={"markers": [first | {"note": None}]}).json()["items"]
    assert resent[0]["note"] == "Editada na web"
    owner.patch(f"/api/v1/markers/{marker_id}", json={"note": None})
    assert owner.patch(f"/api/v1/markers/{marker_id}", json={"note": "x" * 501}).status_code == 422
    assert owner.post(url, json={"markers": []}).status_code == 422
    assert owner.post(url, json={"markers": [_marker(-1)]}).status_code == 422
    assert owner.post(url, json={"markers": [_marker(2**63)]}).status_code == 422

    reader = owner.pat("recordings:read")
    assert len(reader.get(url).json()["items"]) == 2
    assert reader.post(url, json=batch).json()["code"] == "insufficient_scope"

    assert owner.delete(f"/api/v1/markers/{marker_id}").status_code == 204
    assert owner.delete(f"/api/v1/markers/{marker_id}").status_code == 404
    assert owner.get(f"/api/v1/recordings/{recording['id']}").json()["marker_count"] == 1


def test_marker_of_another_account_does_not_exist(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    owner, stranger = as_user(make_user()), as_user(make_user())
    recording = upload_file(owner, audio_bytes(100), markers=[_marker(1_000, "nota")])
    marker_id = _markers(owner, recording["id"])[0]["id"]
    url = f"/api/v1/recordings/{recording['id']}/markers"
    assert stranger.get(url).status_code == 404
    assert stranger.post(url, json={"markers": [_marker(2_000)]}).status_code == 404
    assert stranger.patch(f"/api/v1/markers/{marker_id}", json={"note": "invadido"}).status_code == 404
    assert stranger.delete(f"/api/v1/markers/{marker_id}").status_code == 404
    assert _markers(owner, recording["id"])[0]["note"] == "nota"


def test_agenda_type_chosen_when_stopping_the_recording(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    api = as_user(make_user())
    types = {item["name"]: item for item in api.get("/api/v1/agenda-types").json()["items"]}
    team = types["Reunião de equipe"]
    recording = upload_file(api, audio_bytes(100), agenda_type_id=team["id"])
    assert recording["agenda_type"] == {"id": team["id"], "name": "Reunião de equipe", "origin": "edited"}
    assert set(team["default_tags"]) <= set(recording["tags"])
    assert recording["title"].startswith("Reunião de equipe · ")
    # The title pattern does not replace the title the person wrote.
    titled = upload_file(api, audio_bytes(100), title="Planejamento Q4", agenda_type_id=team["id"])
    assert (titled["title"], titled["agenda_type"]["origin"]) == ("Planejamento Q4", "edited")
    invalid = api.post(
        "/api/v1/uploads",
        json={
            "filename": "a.opus",
            "content_type": "audio/ogg",
            "size_bytes": 10,
            "sha256": "1" * 64,
            "agenda_type_id": str(uuid4()),
        },
    )
    assert invalid.status_code == 422
    assert invalid.json()["errors"][0]["field"] == "agenda_type_id"


def test_marker_moves_the_recording_updated_at(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    owner = as_user(make_user())
    recording = upload_file(owner, audio_bytes(100), markers=[_marker(1_000, "nota")])
    url = f"/api/v1/recordings/{recording['id']}"

    def updated() -> str:
        return owner.get(url).json()["updated_at"]

    seen = [updated()]
    marker_id = _markers(owner, recording["id"])[0]["id"]
    owner.post(f"{url}/markers", json={"markers": [_marker(2_000, "outra")]})
    seen.append(updated())
    owner.patch(f"/api/v1/markers/{marker_id}", json={"note": "editada"})
    seen.append(updated())
    owner.delete(f"/api/v1/markers/{marker_id}")
    seen.append(updated())
    assert seen == sorted(seen)
    assert len(set(seen)) == len(seen)
