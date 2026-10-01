"""Cadastro aberto com o aceite do aviso, `notice_required` e `POST /me/notice`."""

from __future__ import annotations

import secrets
from typing import TYPE_CHECKING, Any
from uuid import UUID

from fastapi.testclient import TestClient
from sqlalchemy import update

from eclume_server.accounts import NOTICE_TEXT, NOTICE_VERSION
from eclume_server.app import create_app
from eclume_server.db import tables as t
from eclume_server_testing.api import Api, agenda_types
from eclume_server_testing.conformance import CONFORMANCE
from eclume_server_testing.harness import run

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


def test_cadastro_abre_a_sessao_com_o_aviso_aceito_e_os_tipos_de_agenda(client: TestClient, services: Services):
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
    user_id = api.get("/api/v1/me").json()["user"]["id"]
    types = agenda_types(services, UUID(user_id))
    assert [t["name"] for t in types] == ["Geral", "Reunião de equipe", "1:1", "Conversa com cliente", "Nota de voz"]

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
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user()
    api = as_user(account)
    pat = api.pat("recordings:read")

    async def withdraw(conn: Any) -> None:  # noqa: ANN401
        # A conta migrada: sem aceite, com o PAT do desktop ou do lumea de antes.
        await conn.execute(
            update(t.users).where(t.users.c.id == account.user_id).values(notice_version=None, notice_accepted_at=None)
        )

    run(services.sql(withdraw))
    assert api.get("/api/v1/me").json()["notice_required"] is True
    # A sessão só alcança /me, o aceite e o logout; o PAT segue funcionando.
    blocked = api.get("/api/v1/recordings")
    assert (blocked.status_code, blocked.json()["code"]) == (403, "notice_required")
    assert api.post("/api/v1/tokens", json={"name": "x", "scopes": ["recordings:read"]}).json()["code"] == (
        "notice_required"
    )
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
    assert api.get("/api/v1/recordings").status_code == 200


def test_teto_diario_de_cadastros_por_ip(services: Services):
    import redis  # noqa: PLC0415

    redis.Redis.from_url(services.settings.redis_url).delete("eclume:rl:signup_day:testclient")
    settings = services.settings.model_copy(update={"signups_per_ip_per_day": 2})
    with TestClient(create_app(settings), base_url="https://testserver") as client:
        client.event_hooks["response"] = [CONFORMANCE.check]
        # Só conta o cadastro criado: o recusado não gasta a vez.
        assert client.post("/api/v1/auth/signup", json=_body(notice_version="v0")).status_code == 422
        for _ in range(2):
            assert client.post("/api/v1/auth/signup", json=_body()).status_code == 204
            client.cookies.clear()
        third = client.post("/api/v1/auth/signup", json=_body())
        assert (third.status_code, third.json()["code"]) == (429, "rate_limited")
        assert 0 < int(third.headers["Retry-After"]) <= 24 * 3600
