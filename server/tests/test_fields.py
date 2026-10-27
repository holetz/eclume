"""User fields (`/fields`): built-ins, CRUD, key, validation by kind and isolation."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import UUID

import pytest
from sqlalchemy import select

from eclume_server.db import tables as t
from eclume_server.fields import set_value
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

URL = "/api/v1/fields"
CLIENT = {
    "name": "Cliente",
    "kind": "choice",
    "options": ["Serra Azul", "Vale Verde", "Serra Azul"],
    "instructions": "A empresa cliente de que a conversa trata.",
}


@pytest.fixture
def user(as_user: Callable[[Account], Api], make_user: Callable[..., Account]) -> Api:
    return as_user(make_user())


def _fields(api: Api) -> dict[str, dict]:
    response = api.get(URL)
    assert response.status_code == 200, response.text
    return {item["key"]: item for item in response.json()["items"]}


def test_account_starts_with_title_and_tags(user: Api):
    fields = _fields(user)
    assert list(fields) == ["titulo", "tags"]
    title, tags = fields["titulo"], fields["tags"]
    assert (title["builtin"], title["kind"], title["auto_fill"]) == ("title", "text", True)
    assert (tags["builtin"], tags["kind"]) == ("tags", "list")
    assert title["instructions"].startswith("Um título curto, de até 8 palavras")
    assert "Prefira as tags que você já usa" in tags["instructions"]


def test_create_edit_and_delete_a_field(user: Api):
    created = user.post(URL, json=CLIENT)
    assert created.status_code == 201, created.text
    field = created.json()
    assert (field["key"], field["options"], field["builtin"], field["position"]) == (
        "cliente",
        ["Serra Azul", "Vale Verde"],
        None,
        3,
    )
    # The key does not repeat, does not shadow the title placeholders and strips accents.
    assert user.post(URL, json=CLIENT).json()["key"] == "cliente_2"
    assert user.post(URL, json={"name": "Data", "kind": "text"}).json()["key"] == "data_2"
    assert user.post(URL, json={"name": "Próxima ação!", "kind": "list"}).json()["key"] == "proxima_acao"
    assert user.get(f"{URL}/{field['id']}").json() == field

    for invalid in (
        {"name": "Sem opções", "kind": "choice"},
        {"name": "Texto com opções", "kind": "text", "options": ["a"]},
        {"name": "x", "kind": "data"},
        {"kind": "text"},
    ):
        assert user.post(URL, json=invalid).status_code == 422, invalid

    renamed = user.patch(f"{URL}/{field['id']}", json={"name": "Empresa", "auto_fill": False})
    assert (renamed.json()["name"], renamed.json()["key"], renamed.json()["auto_fill"]) == ("Empresa", "cliente", False)
    as_text = user.patch(f"{URL}/{field['id']}", json={"kind": "text"})
    assert (as_text.json()["kind"], as_text.json()["options"]) == ("text", [])
    assert user.patch(f"{URL}/{field['id']}", json={"kind": "choice"}).status_code == 422
    assert user.patch(f"{URL}/{field['id']}", json={}).status_code == 422
    assert user.patch(f"{URL}/{field['id']}", json={"name": None}).status_code == 422

    assert user.delete(f"{URL}/{field['id']}").status_code == 204
    assert user.get(f"{URL}/{field['id']}").status_code == 404


def test_builtins_are_not_removed_nor_change_kind(user: Api):
    fields = _fields(user)
    title = fields["titulo"]
    refused = user.delete(f"{URL}/{title['id']}")
    assert (refused.status_code, refused.json()["code"]) == (409, "builtin_field")
    assert user.patch(f"{URL}/{title['id']}", json={"kind": "list"}).status_code == 422
    rule = user.patch(f"{URL}/{title['id']}", json={"instructions": "Até 5 palavras."})
    assert rule.json()["instructions"] == "Até 5 palavras."


def test_another_accounts_field_does_not_exist(
    user: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    mine = user.post(URL, json=CLIENT).json()
    other = as_user(make_user())
    assert list(_fields(other)) == ["titulo", "tags"]
    assert other.get(f"{URL}/{mine['id']}").status_code == 404
    assert other.patch(f"{URL}/{mine['id']}", json={"name": "x"}).status_code == 404
    assert other.delete(f"{URL}/{mine['id']}").status_code == 404
    # The same key in another account is another key.
    assert other.post(URL, json=CLIENT).json()["key"] == "cliente"


def test_scopes_and_pagination(user: Api):
    reader = user.pat("recordings:read")
    assert reader.get(URL).status_code == 200
    assert reader.post(URL, json=CLIENT).json()["code"] == "insufficient_scope"
    first = user.get(URL, params={"limit": 1}).json()
    rest = user.get(URL, params={"cursor": first["next_cursor"]}).json()
    assert [item["key"] for item in first["items"] + rest["items"]] == ["titulo", "tags"]


# --- values per recording -----------------------------------------------------------------------


def _values(api: Api, recording_id: str) -> dict[str, dict[str, Any]]:
    response = api.get(f"/api/v1/recordings/{recording_id}/fields")
    assert response.status_code == 200, response.text
    return {item["field"]["key"]: item for item in response.json()["items"]}


def _auto(services: Services, recording_id: str, field_id: str, value: Any) -> None:  # noqa: ANN401
    """An automatic value, as `fill_fields` writes it (connection role)."""

    async def go(conn: Any) -> None:  # noqa: ANN401
        field = (await conn.execute(select(t.fields).where(t.fields.c.id == field_id))).mappings().one()
        await set_value(conn, UUID(recording_id), field, value, "auto", transcript_revision=1, model="m")

    run(services.sql(go))


def test_values_with_origin_edit_and_accept(user: Api, services: Services):
    client = user.post(URL, json=CLIENT).json()
    notes = user.post(URL, json={"name": "Pendências", "kind": "list"}).json()
    recording = upload_file(user, audio_bytes(1200))
    rid = recording["id"]
    values = _values(user, rid)
    assert list(values) == ["titulo", "tags", "cliente", "pendencias"]
    # With no title on upload, the file name has no origin: the automatic value may replace it.
    assert (values["titulo"]["value"], values["titulo"]["origin"]) == ("reuniao", None)
    assert (values["cliente"]["value"], values["cliente"]["origin"], values["cliente"]["updated_at"]) == (None,) * 3

    base = f"/api/v1/recordings/{rid}/fields"
    _auto(services, rid, values["titulo"]["field"]["id"], "Revisão do contrato")
    _auto(services, rid, client["id"], "Serra Azul")
    _auto(services, rid, notes["id"], ["enviar proposta"])
    assert user.get(f"/api/v1/recordings/{rid}").json()["title"] == "Revisão do contrato"

    accepted = user.post(f"{base}/{client['id']}/accept")
    assert accepted.status_code == 200, accepted.text
    by_key = {item["field"]["key"]: item for item in accepted.json()["items"]}
    assert (by_key["cliente"]["origin"], by_key["titulo"]["origin"]) == ("accepted", "auto")
    again = user.post(f"{base}/{client['id']}/accept")
    assert (again.status_code, again.json()["code"]) == (409, "not_auto")

    edited = user.put(f"{base}/{notes['id']}", json={"value": [" ligar ", "ligar", "revisar"]})
    assert {i["field"]["key"]: i for i in edited.json()["items"]}["pendencias"] == {
        **by_key["pendencias"],
        "value": ["ligar", "revisar"],
        "origin": "edited",
        "updated_at": edited.json()["items"][3]["updated_at"],
    }
    for field_id, value in (
        (client["id"], "Outra empresa"),
        (client["id"], ["Serra Azul"]),
        (notes["id"], "texto"),
        (values["titulo"]["field"]["id"], None),
        (values["titulo"]["field"]["id"], "x" * 301),
        (notes["id"], [f"item {n}" for n in range(51)]),
        (notes["id"], ["x" * 301]),
    ):
        assert user.put(f"{base}/{field_id}", json={"value": value}).status_code == 422, value
    assert user.put(f"{base}/{client['id']}", json={}).status_code == 422

    everything = user.post(f"{base}/accept").json()["items"]
    assert [item["origin"] for item in everything] == ["accepted", None, "accepted", "edited"]
    cleared = user.put(f"{base}/{client['id']}", json={"value": None}).json()["items"]
    assert (cleared[2]["value"], cleared[2]["origin"]) == (None, "edited")


def test_user_title_and_tags_become_edited(user: Api):
    recording = upload_file(user, audio_bytes(1300), title="Kickoff", tags=["cliente"])
    values = _values(user, recording["id"])
    assert (values["titulo"]["value"], values["titulo"]["origin"]) == ("Kickoff", "edited")
    assert (values["tags"]["value"], values["tags"]["origin"]) == (["cliente"], "edited")

    plain = upload_file(user, audio_bytes(1400))
    assert _values(user, plain["id"])["tags"]["origin"] is None
    user.patch(f"/api/v1/recordings/{plain['id']}", json={"tags": ["interno"]})
    values = _values(user, plain["id"])
    assert (values["tags"]["value"], values["tags"]["origin"], values["titulo"]["origin"]) == (
        ["interno"],
        "edited",
        None,
    )
    tags_id = values["tags"]["field"]["id"]
    put = user.put(f"/api/v1/recordings/{plain['id']}/fields/{tags_id}", json={"value": ["a", "b"]})
    assert put.status_code == 200
    assert user.get(f"/api/v1/recordings/{plain['id']}").json()["tags"] == ["a", "b"]
    # A tag has the cap of an agenda type's default tags.
    too_long = user.put(f"/api/v1/recordings/{plain['id']}/fields/{tags_id}", json={"value": ["t" * 65]})
    assert too_long.status_code == 422


def test_field_instructions_have_a_cap(user: Api):
    assert user.post(URL, json={**CLIENT, "instructions": "x" * 4001}).status_code == 422
    field = user.post(URL, json={**CLIENT, "instructions": "x" * 4000}).json()
    assert user.patch(f"{URL}/{field['id']}", json={"instructions": "x" * 4001}).status_code == 422


def test_automatic_does_not_overwrite_what_the_user_wrote(user: Api, services: Services):
    notes = user.post(URL, json={"name": "Pendências", "kind": "list"}).json()
    recording = upload_file(user, audio_bytes(1500), title="Kickoff")
    rid = recording["id"]
    user.put(f"/api/v1/recordings/{rid}/fields/{notes['id']}", json={"value": ["ligar"]})
    title_id = _values(user, rid)["titulo"]["field"]["id"]
    # Like a `fill_fields` arriving after the edit: writing the value does not override it.
    _auto(services, rid, title_id, "Outro título")
    _auto(services, rid, notes["id"], ["automático"])
    values = _values(user, rid)
    assert (values["titulo"]["value"], values["titulo"]["origin"]) == ("Kickoff", "edited")
    assert (values["pendencias"]["value"], values["pendencias"]["origin"]) == (["ligar"], "edited")
    assert user.get(f"/api/v1/recordings/{rid}").json()["title"] == "Kickoff"


def test_another_accounts_values_do_not_exist(
    user: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    recording = upload_file(user, audio_bytes(1100))
    field = user.post(URL, json=CLIENT).json()
    other = as_user(make_user())
    base = f"/api/v1/recordings/{recording['id']}/fields"
    assert other.get(base).status_code == 404
    assert other.post(f"{base}/accept").status_code == 404
    assert other.put(f"{base}/{field['id']}", json={"value": "Serra Azul"}).status_code == 404
    own = upload_file(other, audio_bytes(1000))
    # Another account's field does not exist for this one, not even on one of its recordings.
    assert other.put(f"/api/v1/recordings/{own['id']}/fields/{field['id']}", json={"value": "x"}).status_code == 404
    assert user.pat("recordings:read").post(f"{base}/accept").json()["code"] == "insufficient_scope"
