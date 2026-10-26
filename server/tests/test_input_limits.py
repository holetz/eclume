"""Size ceilings on write bodies: at the ceiling is accepted, above it answers 422."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest

from eclume_server import input_limits as lim
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import transcribed

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

SKILL = {"name": "/Limits", "description": "Checks the ceilings.", "instructions": "Do it."}


@pytest.fixture
def api(as_user: Callable[[Account], Api], make_user: Callable[..., Account]) -> Api:
    return as_user(make_user())


def _refused(response: Any, field: str) -> None:  # noqa: ANN401
    assert response.status_code == 422, response.text
    assert response.json()["errors"][0]["field"].startswith(field), response.text


def test_segment_text(api: Api, services: Services):
    base = f"/api/v1/transcripts/{transcribed(api, services.settings)['transcript_id']}/segments/seg-0001"
    assert api.patch(base, json={"text": "a" * lim.MAX_SEGMENT_TEXT}).status_code == 200
    _refused(api.patch(base, json={"text": "a" * (lim.MAX_SEGMENT_TEXT + 1)}), "text")


def test_person_notes_and_email(api: Api):
    ok = {"name": "Ana", "notes": "n" * lim.MAX_PERSON_NOTES, "email": "a" * (lim.MAX_EMAIL - 12) + "@example.com"}
    created = api.post("/api/v1/people", json=ok)
    assert created.status_code == 201, created.text
    url = f"/api/v1/people/{created.json()['id']}"
    _refused(api.post("/api/v1/people", json={"name": "Bo", "notes": "n" * (lim.MAX_PERSON_NOTES + 1)}), "notes")
    long_email = "a" * (lim.MAX_EMAIL - 11) + "@example.com"
    _refused(api.post("/api/v1/people", json={"name": "Bo", "email": long_email}), "email")
    _refused(api.patch(url, json={"notes": "n" * (lim.MAX_PERSON_NOTES + 1)}), "notes")
    _refused(api.patch(url, json={"email": long_email}), "email")
    assert api.patch(url, json={"name": "Ana B"}).status_code == 200


def test_collection_name_and_description(api: Api):
    ok = {"name": "n" * lim.MAX_COLLECTION_NAME, "description": "d" * lim.MAX_COLLECTION_DESCRIPTION}
    created = api.post("/api/v1/collections", json=ok)
    assert created.status_code == 201, created.text
    url = f"/api/v1/collections/{created.json()['id']}"
    _refused(api.post("/api/v1/collections", json={"name": "n" * (lim.MAX_COLLECTION_NAME + 1)}), "name")
    _refused(api.post("/api/v1/collections", json={"name": "x", "description": "d" * 2001}), "description")
    _refused(api.patch(url, json={"name": "n" * (lim.MAX_COLLECTION_NAME + 1)}), "name")
    _refused(api.patch(url, json={"description": "d" * 2001}), "description")


def test_recording_tags_collections_and_metadata(api: Api):
    url = f"/api/v1/recordings/{upload_file(api, audio_bytes(100))['id']}"
    ok = {
        "tags": [f"t{i}".ljust(lim.MAX_RECORDING_TAG_LENGTH, "x") for i in range(lim.MAX_RECORDING_TAGS)],
        "metadata": {
            f"k{i}".ljust(lim.MAX_METADATA_KEY_LENGTH, "k"): "v" * lim.MAX_METADATA_VALUE_LENGTH
            for i in range(lim.MAX_METADATA_ENTRIES)
        },
    }
    assert api.patch(url, json=ok).status_code == 200
    too_many_tags = [f"t{i}" for i in range(lim.MAX_RECORDING_TAGS + 1)]
    _refused(api.patch(url, json={"tags": too_many_tags}), "tags")
    _refused(api.patch(url, json={"tags": ["x" * (lim.MAX_RECORDING_TAG_LENGTH + 1)]}), "tags")
    uuids = [f"00000000-0000-4000-8000-{i:012d}" for i in range(lim.MAX_RECORDING_COLLECTIONS + 1)]
    _refused(api.patch(url, json={"collection_ids": uuids}), "collection_ids")
    too_many_entries = {f"k{i}": "v" for i in range(lim.MAX_METADATA_ENTRIES + 1)}
    _refused(api.patch(url, json={"metadata": too_many_entries}), "metadata")
    _refused(api.patch(url, json={"metadata": {"k" * (lim.MAX_METADATA_KEY_LENGTH + 1): "v"}}), "metadata")
    _refused(api.patch(url, json={"metadata": {"k": "v" * (lim.MAX_METADATA_VALUE_LENGTH + 1)}}), "metadata")


def test_skill_allowed_tools(api: Api):
    skills = "/api/v1/agent/skills"
    too_many = ["tool"] * (lim.MAX_ALLOWED_TOOLS + 1)
    _refused(api.post(skills, json={**SKILL, "allowed_tools": too_many}), "allowed_tools")
    _refused(api.post(skills, json={**SKILL, "allowed_tools": ["t" * (lim.MAX_TOOL_NAME_LENGTH + 1)]}), "allowed_tools")
    created = api.post(skills, json=SKILL)
    assert created.status_code == 201, created.text
    url = f"{skills}/{created.json()['id']}"
    _refused(api.patch(url, json={"allowed_tools": too_many}), "allowed_tools")
    _refused(api.patch(url, json={"allowed_tools": ["t" * (lim.MAX_TOOL_NAME_LENGTH + 1)]}), "allowed_tools")
