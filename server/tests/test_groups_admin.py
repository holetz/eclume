"""Grupos (leitura por membro, escrita por admin) e administração de usuários."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable
    from uuid import UUID

    from eclume_server_testing.api import Account, Api


def test_admin_cria_grupo_e_membro_so_le(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    admin = as_user(make_user(role="admin", name="Mariana Couto"))
    member_account = make_user(name="Rafael Lima")
    member = as_user(member_account)

    created = admin.post("/api/v1/groups", json={"name": "Consultores", "description": "Equipe de campo"})
    assert created.status_code == 201
    group = created.json()
    assert group["member_count"] == 0
    assert "members" not in group

    assert member.post("/api/v1/groups", json={"name": "Outro"}).status_code == 403
    assert admin.post("/api/v1/groups", json={"name": "consultores"}).status_code == 409

    url = f"/api/v1/groups/{group['id']}/members/{member_account.user_id}"
    assert member.put(url).status_code == 403
    assert admin.put(url).status_code == 204
    assert admin.put(url).status_code == 204  # idempotente

    detail = member.get(f"/api/v1/groups/{group['id']}").json()
    assert detail["member_count"] == 1
    assert detail["members"] == [{"id": str(member_account.user_id), "name": "Rafael Lima"}]
    assert member.get("/api/v1/me").json()["groups"] == [{"id": group["id"], "name": "Consultores"}]

    listed = member.get("/api/v1/groups").json()
    assert [g["id"] for g in listed["items"]] == [group["id"]]

    patched = admin.patch(f"/api/v1/groups/{group['id']}", json={"description": None})
    assert patched.status_code == 200
    assert patched.json()["description"] is None
    assert admin.patch(f"/api/v1/groups/{group['id']}", json={}).status_code == 422

    assert admin.delete(url).status_code == 204
    assert member.get(f"/api/v1/groups/{group['id']}").json()["member_count"] == 0
    assert admin.delete(f"/api/v1/groups/{group['id']}").status_code == 204
    assert admin.get(f"/api/v1/groups/{group['id']}").status_code == 404


def test_grupo_e_usuario_de_outra_organizacao_sao_404(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], make_org: Callable[[], UUID]
):
    admin = as_user(make_user(role="admin"))
    other_org = make_org()
    stranger_admin = as_user(make_user(role="admin", org_id=other_org))
    stranger = make_user(org_id=other_org)
    group = admin.post("/api/v1/groups", json={"name": "Diretoria"}).json()
    assert stranger_admin.get(f"/api/v1/groups/{group['id']}").status_code == 404
    assert group["id"] not in [g["id"] for g in stranger_admin.get("/api/v1/groups").json()["items"]]
    assert stranger_admin.delete(f"/api/v1/groups/{group['id']}").status_code == 404
    assert admin.put(f"/api/v1/groups/{group['id']}/members/{stranger.user_id}").status_code == 404
    assert str(stranger.user_id) not in [u["id"] for u in admin.get("/api/v1/admin/users").json()["items"]]
    assert admin.patch(f"/api/v1/admin/users/{stranger.user_id}", json={"role": "admin"}).status_code == 404


def test_admin_lista_usuarios_e_muda_papel(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    admin_account = make_user(role="admin")
    admin = as_user(admin_account)
    member_account = make_user()
    member = as_user(member_account)

    assert member.get("/api/v1/admin/users").status_code == 403
    users = admin.get("/api/v1/admin/users").json()["items"]
    assert {u["id"] for u in users} == {str(admin_account.user_id), str(member_account.user_id)}

    promoted = admin.patch(f"/api/v1/admin/users/{member_account.user_id}", json={"role": "admin", "name": "Nome Novo"})
    assert promoted.status_code == 200
    assert promoted.json()["role"] == "admin"
    assert promoted.json()["name"] == "Nome Novo"
    assert member.get("/api/v1/admin/users").status_code == 200
    assert admin.patch(f"/api/v1/admin/users/{member_account.user_id}", json={"role": None}).status_code == 422


def test_ultimo_admin_nao_se_rebaixa(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    admin_account = make_user(role="admin")
    admin = as_user(admin_account)
    response = admin.patch(f"/api/v1/admin/users/{admin_account.user_id}", json={"role": "member"})
    assert response.status_code == 422
    assert response.json()["errors"] == [
        {"field": "role", "message": "a organização precisa manter ao menos um admin ativo"}
    ]
    assert admin.get("/api/v1/me").json()["user"]["role"] == "admin"


def test_desativar_encerra_sessoes_e_revoga_pats(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    admin = as_user(make_user(role="admin"))
    member_account = make_user()
    member = as_user(member_account)
    pat = member.pat("recordings:read")
    assert pat.get("/api/v1/me").status_code == 200

    response = admin.patch(f"/api/v1/admin/users/{member_account.user_id}", json={"active": False})
    assert response.status_code == 200
    assert response.json()["active"] is False
    assert member.get("/api/v1/me").status_code == 401
    assert pat.get("/api/v1/me").status_code == 401
    client = member.client
    client.cookies.clear()
    relogin = client.post("/api/v1/auth/login", json={"email": member_account.email, "password": "senha-de-teste-123"})
    assert relogin.status_code == 401
