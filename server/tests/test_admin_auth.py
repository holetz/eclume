"""Conta de admin: login, sessão própria, fronteira com as credenciais de usuário e logout."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import text

from eclume_server_testing.api import PASSWORD, Api, admin_login, new_admin
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi.testclient import TestClient

    from eclume_server_testing.api import Account
    from eclume_server_testing.harness import Services


def test_login_de_admin_define_cookies_proprios(client: TestClient, services: Services):
    account = new_admin(services)
    client.cookies.clear()
    response = client.post("/api/v1/admin/auth/login", json={"email": account.email.upper(), "password": PASSWORD})
    assert response.status_code == 204
    set_cookie = response.headers.get_list("set-cookie")
    session = next(c for c in set_cookie if c.startswith("eclume_admin_session="))
    csrf = next(c for c in set_cookie if c.startswith("eclume_admin_csrf="))
    assert "HttpOnly" in session
    assert "Secure" in session
    assert "samesite=strict" in session.lower()
    assert "Path=/api/v1/admin" in session
    assert "HttpOnly" not in csrf
    api = Api(
        client,
        cookies={name: response.cookies[name] for name in ("eclume_admin_session", "eclume_admin_csrf")},
        csrf_cookie="eclume_admin_csrf",
    )
    me = api.get("/api/v1/admin/me").json()
    assert me["email"] == account.email
    assert me["last_login_at"] is not None


def test_login_de_admin_errado_e_401(client: TestClient, services: Services, make_user: Callable[..., Account]):
    account = new_admin(services)
    client.cookies.clear()
    wrong = client.post("/api/v1/admin/auth/login", json={"email": account.email, "password": "outra-senha-qualquer"})
    assert wrong.status_code == 401
    # A conta de usuário não entra no painel, nem com a senha certa.
    user = make_user()
    as_user = client.post("/api/v1/admin/auth/login", json={"email": user.email, "password": PASSWORD})
    assert as_user.status_code == 401


def test_sessao_de_admin_so_alcanca_o_painel(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    assert admin.get("/api/v1/admin/users").status_code == 200
    # Fora de /admin/*, o cookie de admin é ignorado: sem credencial de usuário, 401.
    for url in ("/api/v1/me", "/api/v1/recordings", "/api/v1/people"):
        assert admin.get(url).status_code == 401, url

    user = as_user(make_user())
    pat = user.pat("recordings:read")
    for api in (user, pat, Api(admin.client)):
        for url in ("/api/v1/admin/me", "/api/v1/admin/users", "/api/v1/admin/settings", "/api/v1/admin/health"):
            response = api.get(url)
            assert response.status_code == 401, url
            assert response.json()["code"] == "unauthorized"


def test_csrf_da_sessao_de_admin(admin: Api):
    admin.send_csrf = False
    response = admin.patch("/api/v1/admin/settings", json={"asr": {"model": "large-v3"}})
    assert response.status_code == 401
    assert "eclume_admin_csrf" in response.json()["detail"]
    admin.send_csrf = True
    assert admin.patch("/api/v1/admin/settings", json={"asr": {"model": "large-v3"}}).status_code == 200


def test_logout_de_admin_encerra_a_sessao(admin: Api):
    assert admin.post("/api/v1/admin/auth/logout").status_code == 204
    assert admin.get("/api/v1/admin/me").status_code == 401


def test_admin_desativado_nao_entra(client: TestClient, services: Services):
    account = new_admin(services)
    session = admin_login(client, account.email)

    async def deactivate(conn):  # noqa: ANN001, ANN202
        await conn.execute(text("UPDATE admins SET active = false WHERE id = :id"), {"id": account.user_id})

    run(services.sql(deactivate))
    assert session.get("/api/v1/admin/me").status_code == 401
    client.cookies.clear()
    login = client.post("/api/v1/admin/auth/login", json={"email": account.email, "password": PASSWORD})
    assert login.status_code == 401
