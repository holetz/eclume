"""Campos do usuário (`/fields`): embutidos, CRUD, chave, validação por tipo e isolamento."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api

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


def test_a_conta_nasce_com_titulo_e_tags(user: Api):
    fields = _fields(user)
    assert list(fields) == ["titulo", "tags"]
    title, tags = fields["titulo"], fields["tags"]
    assert (title["builtin"], title["kind"], title["auto_fill"]) == ("title", "text", True)
    assert (tags["builtin"], tags["kind"]) == ("tags", "list")
    assert title["instructions"].startswith("Um título curto, de até 8 palavras")
    assert "Prefira as tags que você já usa" in tags["instructions"]


def test_criar_editar_e_excluir_um_campo(user: Api):
    created = user.post(URL, json=CLIENT)
    assert created.status_code == 201, created.text
    field = created.json()
    assert (field["key"], field["options"], field["builtin"], field["position"]) == (
        "cliente",
        ["Serra Azul", "Vale Verde"],
        None,
        3,
    )
    # A chave não repete, não encobre os marcadores do título e tira os acentos.
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


def test_embutidos_nao_saem_nem_mudam_de_tipo(user: Api):
    fields = _fields(user)
    title = fields["titulo"]
    refused = user.delete(f"{URL}/{title['id']}")
    assert (refused.status_code, refused.json()["code"]) == (409, "builtin_field")
    assert user.patch(f"{URL}/{title['id']}", json={"kind": "list"}).status_code == 422
    rule = user.patch(f"{URL}/{title['id']}", json={"instructions": "Até 5 palavras."})
    assert rule.json()["instructions"] == "Até 5 palavras."


def test_campo_de_outra_conta_nao_existe(
    user: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    mine = user.post(URL, json=CLIENT).json()
    other = as_user(make_user())
    assert list(_fields(other)) == ["titulo", "tags"]
    assert other.get(f"{URL}/{mine['id']}").status_code == 404
    assert other.patch(f"{URL}/{mine['id']}", json={"name": "x"}).status_code == 404
    assert other.delete(f"{URL}/{mine['id']}").status_code == 404
    # A mesma chave em outra conta é outra chave.
    assert other.post(URL, json=CLIENT).json()["key"] == "cliente"


def test_escopos_e_paginacao(user: Api):
    reader = user.pat("recordings:read")
    assert reader.get(URL).status_code == 200
    assert reader.post(URL, json=CLIENT).json()["code"] == "insufficient_scope"
    first = user.get(URL, params={"limit": 1}).json()
    rest = user.get(URL, params={"cursor": first["next_cursor"]}).json()
    assert [item["key"] for item in first["items"] + rest["items"]] == ["titulo", "tags"]
