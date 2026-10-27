"""The Agent skills: registration under RLS, validation, limit and the tool catalog."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text

from eclume_server.agent_skills import MAX_SKILLS
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

SKILLS = "/api/v1/agent/skills"
UNSEEN = "00000000-0000-4000-8000-0000000000ff"
ATA = {
    "name": "/Ata",
    "description": "Escreve a ata de uma reunião com decisões e prazos.",
    "instructions": "## Ata\n\n- Decisões\n- Prazos\n- Responsáveis",
}


@pytest.fixture
def user(as_user: Callable[[Account], Api], make_user: Callable[..., Account]) -> Api:
    return as_user(make_user())


def _create(api: Api, **fields: Any) -> Any:  # noqa: ANN401
    return api.post(SKILLS, json={**ATA, **fields})


def test_skill_created_listed_edited_and_deleted(user: Api):
    created = _create(user)
    assert created.status_code == 201, created.text
    skill = created.json()
    assert (skill["name"], skill["allowed_tools"], skill["enabled"]) == ("ata", None, True)
    assert _create(user, name="checklist", allowed_tools=["search_summaries", "write_file"]).status_code == 201
    listed = user.get(SKILLS).json()["items"]
    assert [item["name"] for item in listed] == ["ata", "checklist"]
    assert listed[1]["allowed_tools"] == ["search_summaries", "write_file"]

    patched = user.patch(f"{SKILLS}/{skill['id']}", json={"enabled": False, "allowed_tools": ["read_summary"]})
    assert patched.status_code == 200, patched.text
    assert (patched.json()["enabled"], patched.json()["allowed_tools"]) == (False, ["read_summary"])
    freed = user.patch(f"{SKILLS}/{skill['id']}", json={"allowed_tools": None})
    assert freed.json()["allowed_tools"] is None
    assert user.get(f"{SKILLS}/{skill['id']}").json()["enabled"] is False

    assert user.delete(f"{SKILLS}/{skill['id']}").status_code == 204
    assert user.get(f"{SKILLS}/{skill['id']}").status_code == 404
    assert [item["name"] for item in user.get(SKILLS).json()["items"]] == ["checklist"]


def test_repeated_or_invalid_name_and_unknown_tool(user: Api):
    assert _create(user).status_code == 201
    taken = _create(user, name="ata")
    assert (taken.status_code, taken.json()["code"]) == (409, "skill_exists")
    assert _create(user, name="Ata Nova").status_code == 422
    assert _create(user, name="a").status_code == 422
    assert _create(user, name="nova", description="   ").status_code == 422
    unknown = _create(user, name="nova", allowed_tools=["delete_recording"])
    assert unknown.status_code == 422
    assert "delete_recording" in unknown.text
    other = _create(user, name="outra").json()
    assert user.patch(f"{SKILLS}/{other['id']}", json={"name": "ata"}).status_code == 409


def test_another_account_cannot_see(user: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    skill = _create(user).json()
    stranger = as_user(make_user())
    assert stranger.get(SKILLS).json()["items"] == []
    assert stranger.get(f"{SKILLS}/{skill['id']}").status_code == 404
    assert stranger.patch(f"{SKILLS}/{skill['id']}", json={"enabled": False}).status_code == 404
    assert stranger.delete(f"{SKILLS}/{skill['id']}").status_code == 404
    assert user.get(f"{SKILLS}/{UNSEEN}").status_code == 404
    # The same word in another account does not collide.
    assert stranger.post(SKILLS, json=ATA).status_code == 201


def test_skill_limit_per_account(user: Api, services: Services):
    for index in range(MAX_SKILLS):
        assert _create(user, name=f"h{index:02d}").status_code == 201
    assert _create(user, name="mais-uma").status_code == 422

    async def count(conn: Any) -> int:  # noqa: ANN401
        return (await conn.execute(text("SELECT count(*) FROM agent_skills"))).scalar_one()

    assert run(services.sql(count)) >= MAX_SKILLS


def test_tool_catalog(user: Api):
    items = {item["name"]: item for item in user.get("/api/v1/agent/tools").json()["items"]}
    assert items["regenerate_summaries"]["kind"] == "action"
    assert items["use_skill"]["kind"] == "read"
    assert items["write_file"]["kind"] == "produce"
