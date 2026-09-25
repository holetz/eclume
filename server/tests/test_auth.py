"""Sessão, CSRF, `me` e PATs (escopos, só-sessão, revogação, expiração)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import text

from eclume_server_testing.api import PASSWORD, Api
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi.testclient import TestClient

    from eclume_server_testing.api import Account
    from eclume_server_testing.harness import Services


def test_health_sem_credencial(client: TestClient):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["contract_version"] == "1.0.0"


def test_login_define_cookies_seguros_e_me_por_sessao(client: TestClient, make_user: Callable[..., Account]):
    user = make_user(role="admin")
    client.cookies.clear()
    response = client.post("/api/v1/auth/login", json={"email": user.email.upper(), "password": PASSWORD})
    assert response.status_code == 204
    set_cookie = response.headers.get_list("set-cookie")
    session = next(c for c in set_cookie if c.startswith("eclume_session="))
    csrf = next(c for c in set_cookie if c.startswith("eclume_csrf="))
    assert "HttpOnly" in session
    assert "Secure" in session
    assert "samesite=lax" in session.lower()
    assert "HttpOnly" not in csrf
    api = Api(
        client,
        cookies={"eclume_session": response.cookies["eclume_session"], "eclume_csrf": response.cookies["eclume_csrf"]},
    )
    me = api.get("/api/v1/me").json()
    assert me["user"]["email"] == user.email
    assert me["user"]["role"] == "admin"
    assert me["user"]["last_login_at"] is not None
    assert me["organization"]["id"] == str(user.org_id)
    assert me["auth"] == {"method": "session", "scopes": me["auth"]["scopes"], "token_id": None}
    assert len(me["auth"]["scopes"]) == 8


def test_login_errado_e_sem_credencial_sao_401(client: TestClient, make_user: Callable[..., Account]):
    user = make_user()
    client.cookies.clear()
    wrong = client.post("/api/v1/auth/login", json={"email": user.email, "password": "outra-senha-qualquer"})
    assert wrong.status_code == 401
    assert wrong.json()["code"] == "unauthorized"
    unknown = client.post("/api/v1/auth/login", json={"email": "ninguem@exemplo.com.br", "password": "x"})
    assert unknown.status_code == 401
    anonymous = client.get("/api/v1/me")
    assert anonymous.status_code == 401
    assert anonymous.headers["content-type"].startswith("application/problem+json")
    assert anonymous.headers["www-authenticate"] == 'Bearer realm="eclume"'
    invalid = client.post("/api/v1/auth/login", json={"email": "nao-e-email", "password": ""})
    assert invalid.status_code == 422
    assert {e["field"] for e in invalid.json()["errors"]} == {"email", "password"}


def test_csrf_obrigatorio_em_metodo_mutavel_com_sessao(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    api = as_user(make_user())
    api.send_csrf = False
    response = api.post("/api/v1/tokens", json={"name": "x", "scopes": ["transcripts:read"]})
    assert response.status_code == 403
    assert response.json()["code"] == "forbidden"
    wrong = api.post(
        "/api/v1/tokens", json={"name": "x", "scopes": ["transcripts:read"]}, headers={"X-CSRF-Token": "errado"}
    )
    assert wrong.status_code == 403
    assert api.get("/api/v1/me").status_code == 200  # GET não exige CSRF


def test_logout_encerra_a_sessao(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    response = api.post("/api/v1/auth/logout")
    assert response.status_code == 204
    assert api.get("/api/v1/me").status_code == 401


def test_pat_criado_listado_usado_e_revogado(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    session = as_user(make_user())
    created = session.post(
        "/api/v1/tokens", json={"name": "lumea — importador", "scopes": ["transcripts:read", "people:read"]}
    )
    assert created.status_code == 201
    body = created.json()
    secret = body["secret"]
    assert secret.startswith("eclp_")
    assert body["token"]["prefix"] == secret[:9]
    pat = Api(session.client, token=secret)
    me = pat.get("/api/v1/me").json()
    assert me["auth"] == {
        "method": "pat",
        "scopes": ["transcripts:read", "people:read"],
        "token_id": body["token"]["id"],
    }

    listed = session.get("/api/v1/tokens").json()
    assert [item["id"] for item in listed["items"]] == [body["token"]["id"]]
    assert listed["items"][0]["last_used_at"] is not None
    assert "secret" not in listed["items"][0]

    assert session.delete(f"/api/v1/tokens/{body['token']['id']}").status_code == 204
    assert pat.get("/api/v1/me").status_code == 401
    revoked = session.get("/api/v1/tokens").json()["items"][0]
    assert revoked["revoked_at"] is not None


def test_pat_invalido_nunca_cai_para_o_cookie(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    session = as_user(make_user())
    response = session.get("/api/v1/me", headers={"Authorization": "Bearer eclp_naoexiste"})
    assert response.status_code == 401


def test_pat_nao_gere_pats_nem_grupos(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    pat = as_user(make_user(role="admin")).pat("recordings:read", "recordings:write")
    for method, url in (("GET", "/api/v1/tokens"), ("GET", "/api/v1/groups"), ("GET", "/api/v1/admin/users")):
        response = pat.request(method, url)
        assert response.status_code == 403, url
        assert response.json()["code"] == "forbidden"
    created = pat.post("/api/v1/tokens", json={"name": "x", "scopes": ["recordings:read"]})
    assert created.status_code == 403


def test_pat_expirado_e_401(as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services):
    session = as_user(make_user())
    soon = (datetime.now(UTC) + timedelta(seconds=1)).isoformat()
    created = session.post("/api/v1/tokens", json={"name": "curto", "scopes": ["recordings:read"], "expires_at": soon})
    assert created.status_code == 201
    past = session.post(
        "/api/v1/tokens",
        json={"name": "passado", "scopes": ["recordings:read"], "expires_at": "2020-01-01T00:00:00Z"},
    )
    assert past.status_code == 422
    assert past.json()["errors"][0]["field"] == "expires_at"

    async def expire(conn):  # noqa: ANN001, ANN202
        await conn.execute(
            text("UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE id = :id"),
            {"id": created.json()["token"]["id"]},
        )

    run(services.sql(expire))
    assert Api(session.client, token=created.json()["secret"]).get("/api/v1/me").status_code == 401


def test_validacao_do_pat(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    session = as_user(make_user())
    for body in (
        {"name": "", "scopes": ["recordings:read"]},
        {"name": "x", "scopes": []},
        {"name": "x", "scopes": ["recordings:admin"]},
        {"name": "x", "scopes": ["recordings:read", "recordings:read"]},
    ):
        response = session.post("/api/v1/tokens", json=body)
        assert response.status_code == 422, body
        assert response.json()["code"] == "validation_failed"


def test_paginacao_dos_pats(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    session = as_user(make_user())
    ids = [
        session.post("/api/v1/tokens", json={"name": f"t{i}", "scopes": ["recordings:read"]}).json()["token"]["id"]
        for i in range(5)
    ]
    first = session.get("/api/v1/tokens", params={"limit": 2}).json()
    assert len(first["items"]) == 2
    seen = [item["id"] for item in first["items"]]
    cursor = first["next_cursor"]
    while cursor:
        page = session.get("/api/v1/tokens", params={"limit": 2, "cursor": cursor}).json()
        seen += [item["id"] for item in page["items"]]
        cursor = page["next_cursor"]
    assert seen == list(reversed(ids))
    assert session.get("/api/v1/tokens", params={"cursor": "lixo"}).status_code == 422
    assert session.get("/api/v1/tokens", params={"limit": 0}).status_code == 422
