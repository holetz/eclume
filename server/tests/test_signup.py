"""Cadastro aberto com o aceite do aviso, `notice_required` e `POST /me/notice`."""

from __future__ import annotations

import secrets
from typing import TYPE_CHECKING, Any

from fastapi.testclient import TestClient

from eclume_server.accounts import NOTICE_TEXT, NOTICE_VERSION
from eclume_server.app import create_app
from eclume_server_testing.api import Api
from eclume_server_testing.conformance import CONFORMANCE

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account
    from eclume_server_testing.harness import Services

PASSWORD = "senha-do-cadastro-2026"


def _body(**changes: Any) -> dict[str, Any]:  # noqa: ANN401
    email = f"nova-{secrets.token_hex(4)}@exemplo.com.br"
    return {"name": "Paulo Andrade", "email": email, "password": PASSWORD, "notice_version": NOTICE_VERSION} | changes


def test_estado_do_cadastro_e_o_aviso(client: TestClient):
    response = client.get("/api/v1/auth/signup")
    assert response.status_code == 200
    assert response.json() == {"open": True, "notice": {"version": NOTICE_VERSION, "text": NOTICE_TEXT}}
    assert "consentimento das pessoas que gravo" in NOTICE_TEXT


def test_cadastro_abre_a_sessao_com_o_aviso_aceito_e_os_templates(client: TestClient):
    body = _body()
    client.cookies.clear()
    response = client.post("/api/v1/auth/signup", json=body)
    assert response.status_code == 204, response.text
    set_cookie = response.headers.get_list("set-cookie")
    assert any(c.startswith("eclume_session=") and "HttpOnly" in c for c in set_cookie)
    api = Api(client, cookies={name: response.cookies[name] for name in ("eclume_session", "eclume_csrf")})
    me = api.get("/api/v1/me").json()
    assert me["user"]["email"] == body["email"]
    assert me["user"]["name"] == "Paulo Andrade"
    assert me["user"]["notice_version"] == NOTICE_VERSION
    assert me["user"]["notice_accepted_at"] is not None
    assert me["user"]["last_login_at"] is not None
    assert me["notice_required"] is False
    templates = api.get("/api/v1/summary-templates").json()["items"]
    assert [t["name"] for t in templates] == ["Ata de reunião", "Resumo executivo", "Decisões e ações"]
    assert [t["name"] for t in templates if t["is_default"]] == ["Ata de reunião"]

    # O login com a senha do cadastro funciona.
    client.cookies.clear()
    assert client.post("/api/v1/auth/login", json={"email": body["email"], "password": PASSWORD}).status_code == 204


def test_email_repetido_e_409(client: TestClient, make_user: Callable[..., Account]):
    existing = make_user()
    response = client.post("/api/v1/auth/signup", json=_body(email=existing.email.upper()))
    assert response.status_code == 409
    assert response.json()["code"] == "email_taken"


def test_sem_o_aviso_em_vigor_e_422(client: TestClient):
    for body in (
        {k: v for k, v in _body().items() if k != "notice_version"},
        _body(notice_version="0"),
        _body(notice_version=""),
        _body(password="curta"),
        _body(email="sem-arroba"),
        _body(name="   "),
    ):
        response = client.post("/api/v1/auth/signup", json=body)
        assert response.status_code == 422, body
        assert response.json()["code"] == "validation_failed"
    wrong = client.post("/api/v1/auth/signup", json=_body(notice_version="0")).json()
    assert [e["field"] for e in wrong["errors"]] == ["notice_version"]


def test_cadastro_fechado_e_403(services: Services):
    settings = services.settings.model_copy(update={"signup_open": False})
    with TestClient(create_app(settings), base_url="https://testserver") as closed:
        closed.event_hooks["response"] = [CONFORMANCE.check]
        assert closed.get("/api/v1/auth/signup").json()["open"] is False
        response = closed.post("/api/v1/auth/signup", json=_body())
        assert response.status_code == 403
        assert response.json()["code"] == "signup_closed"


def test_conta_sem_aceite_aceita_o_aviso_por_sessao(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    api = as_user(make_user())
    assert api.get("/api/v1/me").json()["notice_required"] is True
    # O aceite não bloqueia a API: o PAT do desktop e do lumea segue funcionando.
    pat = api.pat("recordings:read")
    assert pat.get("/api/v1/recordings").status_code == 200
    denied = pat.post("/api/v1/me/notice", json={"notice_version": NOTICE_VERSION})
    assert (denied.status_code, denied.json()["code"]) == (403, "session_required")

    old = api.post("/api/v1/me/notice", json={"notice_version": "0"})
    assert old.status_code == 422
    assert old.json()["errors"][0]["field"] == "notice_version"
    assert api.post("/api/v1/me/notice", json={"notice_version": NOTICE_VERSION}).status_code == 204
    me = api.get("/api/v1/me").json()
    assert me["notice_required"] is False
    assert me["user"]["notice_version"] == NOTICE_VERSION
    assert pat.get("/api/v1/me").json()["notice_required"] is False
