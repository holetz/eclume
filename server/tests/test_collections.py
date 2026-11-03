"""User collections (a recording in N collections) and the tags of visible recordings."""

from __future__ import annotations

from typing import TYPE_CHECKING

from eclume_server.input_limits import MAX_COLLECTION_NAME
from eclume_server_testing.api import audio_bytes, upload_file

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api


def test_catalog_order_and_pagination(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    created = api.post("/api/v1/collections", json={"name": "Metalúrgica Serra Azul", "description": "Lideranças"})
    assert created.status_code == 201
    collection = created.json()
    assert (collection["recording_count"], collection["description"]) == (0, "Lideranças")
    api.post("/api/v1/collections", json={"name": "acme"})
    api.post("/api/v1/collections", json={"name": "Zeta"})
    assert api.post("/api/v1/collections", json={"name": ""}).status_code == 422

    first = api.get("/api/v1/collections", params={"limit": 2}).json()
    assert [c["name"] for c in first["items"]] == ["acme", "Metalúrgica Serra Azul"]
    rest = api.get("/api/v1/collections", params={"limit": 2, "cursor": first["next_cursor"]}).json()
    assert ([c["name"] for c in rest["items"]], rest["next_cursor"]) == (["Zeta"], None)

    patched = api.patch(f"/api/v1/collections/{collection['id']}", json={"description": None})
    assert (patched.status_code, patched.json()["description"]) == (200, None)
    assert patched.json()["updated_at"] > collection["updated_at"]
    assert api.patch(f"/api/v1/collections/{collection['id']}", json={}).status_code == 422
    assert api.patch(f"/api/v1/collections/{collection['id']}", json={"name": None}).status_code == 422
    assert api.delete(f"/api/v1/collections/{collection['id']}").status_code == 204
    assert api.patch(f"/api/v1/collections/{collection['id']}", json={"name": "x"}).status_code == 404
    assert api.delete(f"/api/v1/collections/{collection['id']}").status_code == 404


def test_recording_in_several_collections(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    other = as_user(make_user())
    a = api.post("/api/v1/collections", json={"name": "Cliente A"}).json()
    b = api.post("/api/v1/collections", json={"name": "Programa B"}).json()
    foreign_collection = other.post("/api/v1/collections", json={"name": "De outro"}).json()
    recording = upload_file(api, audio_bytes(100), collection_ids=[a["id"]])
    assert recording["collection_ids"] == [a["id"]]

    url = f"/api/v1/recordings/{recording['id']}"
    patched = api.patch(url, json={"collection_ids": [a["id"], b["id"], a["id"]]})
    assert patched.status_code == 200
    assert patched.json()["collection_ids"] == [a["id"], b["id"]]
    assert api.patch(url, json={"collection_ids": [foreign_collection["id"]]}).status_code == 422
    missing = api.patch(url, json={"collection_ids": ["01928f3a-1c00-7a00-8000-000000000801"]})
    assert (missing.status_code, missing.json()["errors"][0]["field"]) == (422, "collection_ids")
    counts = {c["name"]: c["recording_count"] for c in api.get("/api/v1/collections").json()["items"]}
    assert counts == {"Cliente A": 1, "Programa B": 1}
    in_b = api.get("/api/v1/recordings", params={"collection": b["id"]}).json()["items"]
    assert [r["id"] for r in in_b] == [recording["id"]]

    # Deleting the collection only removes it from the recording.
    before = api.get(url).json()
    assert api.delete(f"/api/v1/collections/{a['id']}").status_code == 204
    after = api.get(url).json()
    assert after["collection_ids"] == [b["id"]]
    assert after["updated_at"] > before["updated_at"]

    # An upload asking for another account's collection is refused at creation.
    refused = api.post(
        "/api/v1/uploads",
        json={
            "filename": "x.opus",
            "content_type": "audio/ogg; codecs=opus",
            "size_bytes": 10,
            "sha256": "0" * 64,
            "collection_ids": [foreign_collection["id"]],
        },
    )
    assert (refused.status_code, refused.json()["errors"][0]["field"]) == (422, "collection_ids")


def test_collections_belong_to_the_user(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    alice = as_user(make_user())
    bob = as_user(make_user())
    mine = alice.post("/api/v1/collections", json={"name": "Minha"}).json()
    assert bob.get("/api/v1/collections").json()["items"] == []
    assert bob.patch(f"/api/v1/collections/{mine['id']}", json={"name": "x"}).status_code == 404
    assert bob.delete(f"/api/v1/collections/{mine['id']}").status_code == 404
    reader = alice.pat("recordings:read")
    assert [c["id"] for c in reader.get("/api/v1/collections").json()["items"]] == [mine["id"]]
    denied = reader.post("/api/v1/collections", json={"name": "x"})
    assert (denied.status_code, denied.json()["required_scopes"]) == (403, ["recordings:write"])


def test_tags_of_the_users_recordings(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    alice = as_user(make_user())
    bob = as_user(make_user())
    upload_file(alice, audio_bytes(100), tags=["cliente-a", "entrevista"])
    upload_file(alice, audio_bytes(100), tags=["cliente-a"])
    upload_file(bob, audio_bytes(100), tags=["interno"])
    # The catalog has the tags written on uploads and the default tags of the account's types.
    counts = {tag["name"]: tag["count"] for tag in alice.get("/api/v1/tags").json()["items"]}
    assert counts == {"cliente-a": 2, "entrevista": 1, "interno": 0, "planejamento": 0}
    counts = {tag["name"]: tag["count"] for tag in bob.get("/api/v1/tags").json()["items"]}
    assert counts == {"interno": 1, "planejamento": 0}


def test_renaming_the_collection_moves_its_recordings_updated_at(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    """The name is the subfolder of the desktop's synced folder: the recordings must reappear in `?since=`."""
    api = as_user(make_user())
    a = api.post("/api/v1/collections", json={"name": "Clientes"}).json()
    other_collection = api.post("/api/v1/collections", json={"name": "Interno"}).json()
    inside = upload_file(api, audio_bytes(100), collection_ids=[a["id"]])
    outside = upload_file(api, audio_bytes(101), collection_ids=[other_collection["id"]])

    def stamp(recording_id: str) -> str:
        return api.get(f"/api/v1/recordings/{recording_id}").json()["updated_at"]

    inside_before, outside_before = stamp(inside["id"]), stamp(outside["id"])
    # Only the description changes: nothing to redo in the folder.
    api.patch(f"/api/v1/collections/{a['id']}", json={"description": "Contas"})
    assert stamp(inside["id"]) == inside_before

    assert api.patch(f"/api/v1/collections/{a['id']}", json={"name": "Clientes 2026"}).status_code == 200
    assert stamp(inside["id"]) > inside_before
    assert stamp(outside["id"]) == outside_before
    listed = api.get("/api/v1/recordings", params={"since": inside_before}).json()["items"]
    assert inside["id"] in [r["id"] for r in listed]


def test_collection_rule_and_merge(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    rule = "Reuniões com alguém da empresa Agro Sul."
    auto = api.post("/api/v1/collections", json={"name": "Agro Sul", "instructions": rule, "auto_assign": True})
    assert auto.status_code == 201, auto.text
    assert (auto.json()["instructions"], auto.json()["auto_assign"]) == (rule, True)
    plain = api.post("/api/v1/collections", json={"name": "Clientes"}).json()
    assert (plain["instructions"], plain["auto_assign"]) == ("", False)
    assert api.post("/api/v1/collections", json={"name": "X", "instructions": "x" * 4001}).status_code == 422
    turned = api.patch(f"/api/v1/collections/{plain['id']}", json={"auto_assign": True, "instructions": "Clientes."})
    assert (turned.json()["auto_assign"], turned.json()["instructions"]) == (True, "Clientes.")
    assert api.patch(f"/api/v1/collections/{plain['id']}", json={"auto_assign": None}).status_code == 422

    both = upload_file(api, audio_bytes(100), collection_ids=[auto.json()["id"], plain["id"]])
    only = upload_file(api, audio_bytes(100), collection_ids=[auto.json()["id"]])
    merged = api.post(f"/api/v1/collections/{auto.json()['id']}/merge", json={"into": plain["id"]})
    assert merged.status_code == 200, merged.text
    assert (merged.json()["name"], merged.json()["recording_count"]) == ("Clientes", 2)
    assert api.get(f"/api/v1/recordings/{both['id']}").json()["collection_ids"] == [plain["id"]]
    assert api.get(f"/api/v1/recordings/{only['id']}").json()["collection_ids"] == [plain["id"]]
    assert [c["name"] for c in api.get("/api/v1/collections").json()["items"]] == ["Clientes"]

    assert api.post(f"/api/v1/collections/{plain['id']}/merge", json={"into": plain["id"]}).status_code == 422
    foreign = as_user(make_user()).post("/api/v1/collections", json={"name": "Alheia"}).json()
    refused = api.post(f"/api/v1/collections/{plain['id']}/merge", json={"into": foreign["id"]})
    assert (refused.status_code, refused.json()["errors"][0]["field"]) == (422, "into")
    assert api.post(f"/api/v1/collections/{foreign['id']}/merge", json={"into": plain["id"]}).status_code == 404


def test_touching_collections_locks_the_origin(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    a = api.post("/api/v1/collections", json={"name": "A"}).json()
    recording = upload_file(api, audio_bytes(100), collection_ids=[a["id"]])
    assert recording["collections_origin"] is None
    patched = api.patch(f"/api/v1/recordings/{recording['id']}", json={"collection_ids": []})
    assert (patched.json()["collection_ids"], patched.json()["collections_origin"]) == ([], "edited")


def test_tag_catalog_rename_merge_and_delete(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    created = api.post("/api/v1/tags", json={"name": " Cliente ", "description": "Conversas com clientes."})
    assert created.status_code == 201, created.text
    client_tag = created.json()
    assert (client_tag["name"], client_tag["origin"], client_tag["count"]) == ("Cliente", "user", 0)
    duplicate = api.post("/api/v1/tags", json={"name": "clíente"})
    assert (duplicate.status_code, duplicate.json()["code"]) == (409, "tag_exists")

    # A tag the user writes enters the catalog in the user's spelling.
    recording = upload_file(api, audio_bytes(100), tags=["cliente", "Proposta"])
    assert api.get(f"/api/v1/recordings/{recording['id']}").json()["tags"] == ["Cliente", "Proposta"]
    types = {t["name"]: t for t in api.get("/api/v1/agenda-types").json()["items"]}
    team = types["Reunião de equipe"]
    patched = api.patch(f"/api/v1/agenda-types/{team['id']}", json={"default_tags": ["interno", "CLIENTE"]})
    assert patched.json()["default_tags"] == ["interno", "Cliente"]

    renamed = api.patch(f"/api/v1/tags/{client_tag['id']}", json={"name": "clientes"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["count"] == 1
    assert api.get(f"/api/v1/recordings/{recording['id']}").json()["tags"] == ["clientes", "Proposta"]
    assert api.get(f"/api/v1/agenda-types/{team['id']}").json()["default_tags"] == ["interno", "clientes"]
    proposal_tag = next(t for t in api.get("/api/v1/tags").json()["items"] if t["name"] == "Proposta")
    taken = api.patch(f"/api/v1/tags/{proposal_tag['id']}", json={"name": "Clientes"})
    assert (taken.status_code, taken.json()["code"]) == (409, "tag_exists")

    merged = api.post(f"/api/v1/tags/{proposal_tag['id']}/merge", json={"into": client_tag["id"]})
    assert merged.status_code == 200, merged.text
    assert api.get(f"/api/v1/recordings/{recording['id']}").json()["tags"] == ["clientes"]
    assert api.post(f"/api/v1/tags/{client_tag['id']}/merge", json={"into": client_tag["id"]}).status_code == 422

    assert api.delete(f"/api/v1/tags/{client_tag['id']}").status_code == 204
    assert api.get(f"/api/v1/recordings/{recording['id']}").json()["tags"] == []
    assert api.get(f"/api/v1/agenda-types/{team['id']}").json()["default_tags"] == ["interno"]
    assert api.delete(f"/api/v1/tags/{client_tag['id']}").status_code == 404
    other = as_user(make_user())
    assert other.patch(f"/api/v1/tags/{proposal_tag['id']}", json={"description": "x"}).status_code == 404


def test_automatic_tags_settings(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    current = api.get("/api/v1/me/tag-assignment").json()
    assert (current["auto_fill"], current["mode"], current["new_limit"], current["catalog_limit"]) == (
        True,
        "fixed",
        1,
        200,
    )
    assert current["instructions"].startswith("De 1 a 5 tags")
    changed = api.patch(
        "/api/v1/me/tag-assignment",
        json={"mode": "auto", "new_limit": 3, "instructions": "Até 3 tags.", "auto_fill": False},
    )
    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert (body["mode"], body["new_limit"], body["instructions"], body["auto_fill"]) == (
        "auto",
        3,
        "Até 3 tags.",
        False,
    )
    assert api.patch("/api/v1/me/tag-assignment", json={"new_limit": 9}).status_code == 422
    assert api.patch("/api/v1/me/tag-assignment", json={"mode": None}).status_code == 422
    assert api.patch("/api/v1/me/tag-assignment", json={}).status_code == 422
    assert api.pat("recordings:read").get("/api/v1/me/tag-assignment").status_code in {401, 403}


def test_collection_cursor_with_long_name_is_accepted_back(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    api = as_user(make_user())
    long_name = "c" * MAX_COLLECTION_NAME
    for name in ("acme", long_name, "zeta"):
        assert api.post("/api/v1/collections", json={"name": name}).status_code == 201

    seen: list[str] = []
    cursor = None
    while True:
        params = {"limit": 1} | ({"cursor": cursor} if cursor else {})
        response = api.get("/api/v1/collections", params=params)
        assert response.status_code == 200, response.text
        seen += [c["name"] for c in response.json()["items"]]
        cursor = response.json()["next_cursor"]
        if cursor is None:
            break
    assert seen == ["acme", long_name, "zeta"]
