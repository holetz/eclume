"""Coleções do usuário (gravação em N coleções) e tags das gravações visíveis."""

from __future__ import annotations

from typing import TYPE_CHECKING

from eclume_server_testing.api import audio_bytes, upload_file

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api


def test_cadastro_ordem_e_paginacao(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    created = api.post("/api/v1/collections", json={"name": "Metalúrgica Serra Azul", "description": "Lideranças"})
    assert created.status_code == 201
    serra = created.json()
    assert (serra["recording_count"], serra["description"]) == (0, "Lideranças")
    api.post("/api/v1/collections", json={"name": "acme"})
    api.post("/api/v1/collections", json={"name": "Zeta"})
    assert api.post("/api/v1/collections", json={"name": ""}).status_code == 422

    first = api.get("/api/v1/collections", params={"limit": 2}).json()
    assert [c["name"] for c in first["items"]] == ["acme", "Metalúrgica Serra Azul"]
    rest = api.get("/api/v1/collections", params={"limit": 2, "cursor": first["next_cursor"]}).json()
    assert ([c["name"] for c in rest["items"]], rest["next_cursor"]) == (["Zeta"], None)

    patched = api.patch(f"/api/v1/collections/{serra['id']}", json={"description": None})
    assert (patched.status_code, patched.json()["description"]) == (200, None)
    assert patched.json()["updated_at"] > serra["updated_at"]
    assert api.patch(f"/api/v1/collections/{serra['id']}", json={}).status_code == 422
    assert api.patch(f"/api/v1/collections/{serra['id']}", json={"name": None}).status_code == 422
    assert api.delete(f"/api/v1/collections/{serra['id']}").status_code == 204
    assert api.patch(f"/api/v1/collections/{serra['id']}", json={"name": "x"}).status_code == 404
    assert api.delete(f"/api/v1/collections/{serra['id']}").status_code == 404


def test_gravacao_em_varias_colecoes(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    other = as_user(make_user())
    a = api.post("/api/v1/collections", json={"name": "Cliente A"}).json()
    b = api.post("/api/v1/collections", json={"name": "Programa B"}).json()
    alheia = other.post("/api/v1/collections", json={"name": "De outro"}).json()
    recording = upload_file(api, audio_bytes(100), collection_ids=[a["id"]])
    assert recording["collection_ids"] == [a["id"]]

    url = f"/api/v1/recordings/{recording['id']}"
    patched = api.patch(url, json={"collection_ids": [a["id"], b["id"], a["id"]]})
    assert patched.status_code == 200
    assert patched.json()["collection_ids"] == [a["id"], b["id"]]
    assert api.patch(url, json={"collection_ids": [alheia["id"]]}).status_code == 422
    missing = api.patch(url, json={"collection_ids": ["01928f3a-1c00-7a00-8000-000000000801"]})
    assert (missing.status_code, missing.json()["errors"][0]["field"]) == (422, "collection_ids")
    counts = {c["name"]: c["recording_count"] for c in api.get("/api/v1/collections").json()["items"]}
    assert counts == {"Cliente A": 1, "Programa B": 1}
    in_b = api.get("/api/v1/recordings", params={"collection": b["id"]}).json()["items"]
    assert [r["id"] for r in in_b] == [recording["id"]]

    # Excluir a coleção só a tira da gravação.
    before = api.get(url).json()
    assert api.delete(f"/api/v1/collections/{a['id']}").status_code == 204
    after = api.get(url).json()
    assert after["collection_ids"] == [b["id"]]
    assert after["updated_at"] > before["updated_at"]

    # Upload pedindo coleção alheia é recusado já na criação.
    refused = api.post(
        "/api/v1/uploads",
        json={
            "filename": "x.opus",
            "content_type": "audio/ogg; codecs=opus",
            "size_bytes": 10,
            "sha256": "0" * 64,
            "collection_ids": [alheia["id"]],
        },
    )
    assert (refused.status_code, refused.json()["errors"][0]["field"]) == (422, "collection_ids")


def test_colecoes_sao_do_usuario(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
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


def test_tags_das_gravacoes_do_usuario(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    alice = as_user(make_user())
    bob = as_user(make_user())
    upload_file(alice, audio_bytes(100), tags=["cliente-a", "entrevista"])
    upload_file(alice, audio_bytes(100), tags=["cliente-a"])
    upload_file(bob, audio_bytes(100), tags=["interno"])
    assert alice.get("/api/v1/tags").json() == {
        "items": [{"name": "cliente-a", "count": 2}, {"name": "entrevista", "count": 1}]
    }
    assert bob.get("/api/v1/tags").json() == {"items": [{"name": "interno", "count": 1}]}


def test_renomear_a_colecao_move_o_updated_at_das_gravacoes_dela(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    """O nome é a subpasta da pasta sincronizada do desktop: as gravações precisam reaparecer no `?since=`."""
    api = as_user(make_user())
    a = api.post("/api/v1/collections", json={"name": "Clientes"}).json()
    outra = api.post("/api/v1/collections", json={"name": "Interno"}).json()
    dentro = upload_file(api, audio_bytes(100), collection_ids=[a["id"]])
    fora = upload_file(api, audio_bytes(101), collection_ids=[outra["id"]])

    def stamp(recording_id: str) -> str:
        return api.get(f"/api/v1/recordings/{recording_id}").json()["updated_at"]

    antes_dentro, antes_fora = stamp(dentro["id"]), stamp(fora["id"])
    # Só a descrição muda: nada a refazer na pasta.
    api.patch(f"/api/v1/collections/{a['id']}", json={"description": "Contas"})
    assert stamp(dentro["id"]) == antes_dentro

    assert api.patch(f"/api/v1/collections/{a['id']}", json={"name": "Clientes 2026"}).status_code == 200
    assert stamp(dentro["id"]) > antes_dentro
    assert stamp(fora["id"]) == antes_fora
    listed = api.get("/api/v1/recordings", params={"since": antes_dentro}).json()["items"]
    assert dentro["id"] in [r["id"] for r in listed]


def test_regra_da_colecao_e_mesclagem(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
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


def test_mexer_nas_colecoes_trava_a_origem(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    a = api.post("/api/v1/collections", json={"name": "A"}).json()
    recording = upload_file(api, audio_bytes(100), collection_ids=[a["id"]])
    assert recording["collections_origin"] is None
    patched = api.patch(f"/api/v1/recordings/{recording['id']}", json={"collection_ids": []})
    assert (patched.json()["collection_ids"], patched.json()["collections_origin"]) == ([], "edited")
