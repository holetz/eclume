"""Tipos de agenda: os do usuário (`/agenda-types`), o tipo da gravação e os padrão do admin."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import delete, insert, select

from eclume_server.db import tables as t
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

URL = "/api/v1/agenda-types"
DEFAULT_TYPES = ["Reunião de equipe", "1:1", "Conversa com cliente", "Nota de voz"]
DRAFT = {
    "name": "Mentoria",
    "title_pattern": "Mentoria · {assunto}",
    "identify": "Conversa de acompanhamento com a mentorada.",
    "default_tags": ["mentoria", "mentoria", "carreira"],
    "summary_instructions": "## Temas\nUm item por tema.",
}


@pytest.fixture
def user(as_user: Callable[[Account], Api], make_user: Callable[..., Account]) -> Api:
    return as_user(make_user())


def _names(api: Api) -> list[str]:
    response = api.get(URL)
    assert response.status_code == 200, response.text
    return [item["name"] for item in response.json()["items"]]


def test_a_conta_lista_os_tipos_padrao_na_ordem(user: Api):
    assert _names(user) == DEFAULT_TYPES
    first = user.get(URL, params={"limit": 3}).json()
    assert [item["name"] for item in first["items"]] == DEFAULT_TYPES[:3]
    rest = user.get(URL, params={"limit": 3, "cursor": first["next_cursor"]}).json()
    assert ([item["name"] for item in rest["items"]], rest["next_cursor"]) == (DEFAULT_TYPES[3:], None)
    assert user.get(URL, params={"cursor": "lixo"}).status_code == 422


def test_criar_editar_e_excluir_um_tipo(user: Api):
    created = user.post(URL, json=DRAFT)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["default_tags"] == ["mentoria", "carreira"]
    assert body["position"] == 5
    assert _names(user) == [*DEFAULT_TYPES, "Mentoria"]
    assert user.get(f"{URL}/{body['id']}").json() == body

    assert user.post(URL, json=DRAFT).status_code == 409
    assert user.post(URL, json={"name": "Sem instruções"}).status_code == 422
    assert user.post(URL, json={**DRAFT, "name": "X", "extra": 1}).status_code == 422

    first = user.post(URL, json={**DRAFT, "name": "Primeiro", "position": 0}).json()
    assert _names(user)[0] == "Primeiro"

    patched = user.patch(f"{URL}/{body['id']}", json={"title_pattern": None, "default_tags": []})
    assert patched.status_code == 200, patched.text
    assert (patched.json()["title_pattern"], patched.json()["default_tags"]) == (None, [])
    assert user.patch(f"{URL}/{body['id']}", json={}).status_code == 422
    assert user.patch(f"{URL}/{body['id']}", json={"summary_instructions": None}).status_code == 422
    taken = user.patch(f"{URL}/{body['id']}", json={"name": "1:1"})
    assert (taken.status_code, taken.json()["errors"][0]["field"]) == (422, "name")

    assert user.delete(f"{URL}/{first['id']}").status_code == 204
    assert user.get(f"{URL}/{first['id']}").status_code == 404
    assert user.delete(f"{URL}/{first['id']}").status_code == 404


def test_tipo_de_outra_conta_nao_existe(
    user: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    mine = user.post(URL, json=DRAFT).json()
    other = as_user(make_user())
    assert _names(other) == DEFAULT_TYPES
    assert other.get(f"{URL}/{mine['id']}").status_code == 404
    assert other.patch(f"{URL}/{mine['id']}", json={"name": "x"}).status_code == 404
    assert other.delete(f"{URL}/{mine['id']}").status_code == 404
    # O mesmo nome em outra conta não conflita.
    assert other.post(URL, json=DRAFT).status_code == 201


def test_escopos_do_pat(user: Api):
    reader = user.pat("summaries:read")
    assert reader.get(URL).status_code == 200
    assert reader.post(URL, json=DRAFT).json()["code"] == "insufficient_scope"
    assert user.pat("summaries:read", "summaries:write").post(URL, json=DRAFT).status_code == 201


def _recording(api: Api) -> dict[str, Any]:
    return upload_file(api, audio_bytes(1500), title="Reunião de segunda")


def test_o_usuario_escolhe_o_tipo_da_gravacao(
    user: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    recording = _recording(user)
    assert recording["agenda_type"] is None
    types = {item["name"]: item for item in user.get(URL).json()["items"]}
    url = f"/api/v1/recordings/{recording['id']}"

    chosen = user.patch(url, json={"agenda_type_id": types["1:1"]["id"]})
    assert chosen.status_code == 200, chosen.text
    assert chosen.json()["agenda_type"] == {"id": types["1:1"]["id"], "name": "1:1", "origin": "edited"}
    assert user.get(url).json()["agenda_type"]["name"] == "1:1"

    foreign = as_user(make_user()).get(URL).json()["items"][0]
    refused = user.patch(url, json={"agenda_type_id": foreign["id"]})
    assert (refused.status_code, refused.json()["errors"][0]["field"]) == (422, "agenda_type_id")

    cleared = user.patch(url, json={"agenda_type_id": None})
    assert cleared.json()["agenda_type"] is None

    # Excluir o tipo deixa a gravação sem tipo.
    user.patch(url, json={"agenda_type_id": types["Nota de voz"]["id"]})
    assert user.delete(f"{URL}/{types['Nota de voz']['id']}").status_code == 204
    assert user.get(url).json()["agenda_type"] is None


# --- tipos padrão do admin ------------------------------------------------------------------------

ADMIN_URL = "/api/v1/admin/default-agenda-types"


@pytest.fixture
def defaults(services: Services) -> Iterator[None]:
    """Tipos padrão como a migration os deixou, antes e depois: a plataforma é uma só na sessão."""

    async def snapshot(conn: Any) -> list[dict[str, Any]]:  # noqa: ANN401
        return [dict(row) for row in (await conn.execute(select(t.default_agenda_types))).mappings()]

    saved = run(services.sql(snapshot))

    async def restore(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(delete(t.default_agenda_types))
        await conn.execute(insert(t.default_agenda_types), saved)

    yield
    run(services.sql(restore))


def test_so_a_sessao_de_admin_mantem_os_tipos_padrao(user: Api):
    assert user.get(ADMIN_URL).status_code == 401
    assert user.post(ADMIN_URL, json=DRAFT).status_code == 401


def test_tipos_padrao_valem_para_contas_novas(
    admin: Api, defaults: None, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    del defaults
    listed = admin.get(ADMIN_URL).json()["items"]
    assert [item["name"] for item in listed] == DEFAULT_TYPES
    assert all(item["include_for_new_users"] for item in listed)
    before = as_user(make_user())

    created = admin.post(ADMIN_URL, json=DRAFT)
    assert created.status_code == 201, created.text
    assert (created.json()["position"], created.json()["default_tags"]) == (5, ["mentoria", "carreira"])
    assert admin.post(ADMIN_URL, json=DRAFT).status_code == 409
    voice_note = next(item for item in listed if item["name"] == "Nota de voz")
    hidden = admin.patch(f"{ADMIN_URL}/{voice_note['id']}", json={"include_for_new_users": False})
    assert hidden.json()["include_for_new_users"] is False
    team = listed[0]
    renamed = admin.patch(f"{ADMIN_URL}/{team['id']}", json={"identify": "Reunião interna."})
    assert renamed.json()["identify"] == "Reunião interna."
    assert admin.patch(f"{ADMIN_URL}/{team['id']}", json={"name": "1:1"}).status_code == 422
    assert admin.patch(f"{ADMIN_URL}/{team['id']}", json={"include_for_new_users": None}).status_code == 422

    after = as_user(make_user())
    assert _names(after) == [*DEFAULT_TYPES[:3], "Mentoria"]
    (copied,) = [item for item in after.get(URL).json()["items"] if item["name"] == "Reunião de equipe"]
    assert copied["identify"] == "Reunião interna."
    # Quem já tinha conta fica com as cópias dela.
    assert _names(before) == DEFAULT_TYPES

    assert admin.delete(f"{ADMIN_URL}/{created.json()['id']}").status_code == 204
    assert admin.delete(f"{ADMIN_URL}/{created.json()['id']}").status_code == 404
    assert admin.patch(f"{ADMIN_URL}/{created.json()['id']}", json={"name": "x"}).status_code == 404
    assert "Mentoria" in _names(after)
