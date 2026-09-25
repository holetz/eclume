"""Convites por link: criação, aceite com sessão e grupos, expiração, revogação e permissões."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text

from eclume_server_testing.api import Api, login
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi.testclient import TestClient

    from eclume_server_testing.api import Account
    from eclume_server_testing.harness import Services

URL = "/api/v1/admin/invitations"
NEW_PASSWORD = "senha-do-convidado-1"


def _token(invitation: dict[str, Any]) -> str:
    return invitation["accept_url"].rsplit("/convite/", 1)[1]


def _accept(client: TestClient, token: str, **body: Any) -> Any:  # noqa: ANN401
    client.cookies.clear()
    response = client.post(
        f"/api/v1/auth/invitations/{token}/accept", json={"name": "Beatriz Nunes", "password": NEW_PASSWORD} | body
    )
    client.cookies.clear()
    return response


@pytest.fixture
def admin(as_user: Callable[[Account], Api], make_user: Callable[..., Account]) -> Api:
    return as_user(make_user(role="admin", name="Mariana Couto"))


def test_convite_cria_a_conta_com_sessao_e_grupos(admin: Api, client: TestClient):
    group = admin.post("/api/v1/groups", json={"name": "Consultores"}).json()
    created = admin.post(URL, json={"email": "Beatriz.Nunes@exemplo.com.br", "group_ids": [group["id"]]})
    assert created.status_code == 201, created.text
    invitation = created.json()
    assert invitation["status"] == "pending"
    assert invitation["role"] == "member"
    assert invitation["created_by"]["name"] == "Mariana Couto"
    assert invitation["accept_url"].startswith("https://testserver/convite/ecli_")
    token = _token(invitation)

    listed = admin.get(URL).json()["items"]
    assert [i["id"] for i in listed] == [invitation["id"]]
    assert "accept_url" not in listed[0]
    assert token not in admin.get(URL).text

    # Mesmo e-mail com convite pendente → 409.
    assert admin.post(URL, json={"email": "beatriz.nunes@exemplo.com.br"}).status_code == 409

    accepted = _accept(client, token)
    assert accepted.status_code == 204, accepted.text
    session = Api(client, cookies={name: accepted.cookies[name] for name in ("eclume_session", "eclume_csrf")})
    me = session.get("/api/v1/me").json()
    assert me["user"]["email"] == "Beatriz.Nunes@exemplo.com.br"
    assert me["user"]["role"] == "member"
    assert me["groups"] == [{"id": group["id"], "name": "Consultores"}]
    assert login(client, "beatriz.nunes@exemplo.com.br", NEW_PASSWORD).get("/api/v1/me").status_code == 200

    assert _accept(client, token).status_code == 404  # já usado
    assert admin.get(URL).json()["items"][0]["status"] == "accepted"
    assert admin.delete(f"{URL}/{invitation['id']}").status_code == 404  # aceito não se revoga
    # Conta existente → 409.
    assert admin.post(URL, json={"email": "beatriz.nunes@exemplo.com.br"}).status_code == 409


def test_convite_de_admin_expira_e_se_revoga(admin: Api, client: TestClient, services: Services):
    invitation = admin.post(URL, json={"email": "ana@exemplo.com.br", "role": "admin", "expires_in_days": 1}).json()
    assert invitation["role"] == "admin"

    async def expire(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(
            text("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = :id"),
            {"id": invitation["id"]},
        )

    run(services.sql(expire))
    assert admin.get(URL).json()["items"][0]["status"] == "expired"
    assert _accept(client, _token(invitation)).status_code == 404
    # Expirado não bloqueia um convite novo para o mesmo e-mail.
    again = admin.post(URL, json={"email": "ana@exemplo.com.br", "role": "admin"})
    assert again.status_code == 201

    assert admin.delete(f"{URL}/{again.json()['id']}").status_code == 204
    assert _accept(client, _token(again.json())).status_code == 404
    assert admin.delete(f"{URL}/{again.json()['id']}").status_code == 404

    third = admin.post(URL, json={"email": "ana@exemplo.com.br", "role": "admin"}).json()
    assert _accept(client, _token(third)).status_code == 204
    ana = login(client, "ana@exemplo.com.br", NEW_PASSWORD)
    assert ana.get("/api/v1/admin/users").status_code == 200


def test_validacao_e_permissoes(
    admin: Api,
    client: TestClient,
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    make_org: Callable[[], Any],
):
    for body in (
        {"email": "sem-arroba"},
        {"email": "x@exemplo.com.br", "role": "dono"},
        {"email": "x@exemplo.com.br", "expires_in_days": 31},
        {"email": "x@exemplo.com.br", "group_ids": ["01928f3a-1c00-7a00-8000-000000000201"]},
    ):
        assert admin.post(URL, json=body).status_code == 422, body

    invitation = admin.post(URL, json={"email": "curta@exemplo.com.br"}).json()
    assert _accept(client, _token(invitation), password="curta").status_code == 422
    assert _accept(client, _token(invitation), name="  ").status_code == 422
    assert _accept(client, "ecli_inexistente").status_code == 404

    member = as_user(make_user())
    assert member.get(URL).status_code == 403
    assert member.post(URL, json={"email": "y@exemplo.com.br"}).status_code == 403
    assert member.delete(f"{URL}/{invitation['id']}").status_code == 403
    assert admin.pat("recordings:read").get(URL).status_code == 401

    # Admin de outra organização não vê nem revoga.
    stranger = as_user(make_user(role="admin", org_id=make_org()))
    assert stranger.get(URL).json()["items"] == []
    assert stranger.delete(f"{URL}/{invitation['id']}").status_code == 404


def test_desativar_ainda_encerra_sessoes_e_pats(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    account = make_user(name="Rafael Lima")
    member = as_user(account)
    pat = member.pat("recordings:read")
    assert admin.patch(f"/api/v1/admin/users/{account.user_id}", json={"active": False}).status_code == 200
    assert member.get("/api/v1/me").status_code == 401
    assert pat.get("/api/v1/me").status_code == 401
    assert admin.patch(f"/api/v1/admin/users/{account.user_id}", json={"active": True}).json()["active"] is True
