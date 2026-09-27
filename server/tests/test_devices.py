"""Credencial de dispositivo: login por e-mail e senha, código de pareamento e limite de tentativas."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

import pytest
import redis
from fastapi.testclient import TestClient
from sqlalchemy import text

from eclume_server.app import create_app
from eclume_server_testing.api import PASSWORD, Api
from eclume_server_testing.conformance import CONFORMANCE
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from eclume_server_testing.api import Account
    from eclume_server_testing.harness import Services


def _login(account: Account, **changes: Any) -> dict[str, Any]:  # noqa: ANN401
    body = {"email": account.email, "password": PASSWORD, "device_name": "Notebook da Mariana", "platform": "windows"}
    return body | changes


@pytest.fixture
def limited(services: Services) -> Iterator[TestClient]:
    """App com 3 tentativas por minuto, sem as janelas que os outros testes abriram."""
    store = redis.Redis.from_url(services.settings.redis_url)
    for key in store.scan_iter("eclume:rl:*"):
        store.delete(key)
    settings = services.settings.model_copy(update={"credential_attempts_per_minute": 3})
    with TestClient(create_app(settings), base_url="https://testserver") as client:
        client.event_hooks["response"] = [CONFORMANCE.check]
        yield client


def test_login_de_dispositivo_emite_o_token_do_aparelho(
    client: TestClient, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    account = make_user()
    client.cookies.clear()
    response = client.post("/api/v1/devices/login", json=_login(account, email=account.email.upper()))
    assert response.status_code == 201
    credential = response.json()
    token = credential["token"]
    assert (token["name"], token["kind"], token["platform"]) == ("Notebook da Mariana", "device", "windows")
    assert token["scopes"] == ["recordings:read", "recordings:write"]
    assert token["expires_at"] is None
    assert credential["server"]["url"] == "https://testserver"
    assert credential["server"]["mcp_url"] == "https://testserver/mcp"

    device = Api(client, token=credential["secret"])
    me = device.get("/api/v1/me").json()
    assert me["auth"] == {"method": "pat", "scopes": token["scopes"], "token_id": token["id"]}
    assert device.get("/api/v1/recordings").status_code == 200

    # Aparece em "App móvel" e "App desktop", e desvincular desliga o aparelho.
    session = as_user(account)
    devices = session.get("/api/v1/tokens", params={"kind": "device"}).json()["items"]
    assert [d["id"] for d in devices] == [token["id"]]
    assert session.delete(f"/api/v1/tokens/{token['id']}").status_code == 204
    assert device.get("/api/v1/me").status_code == 401


def test_login_de_dispositivo_errado_e_401_como_o_login(client: TestClient, make_user: Callable[..., Account]):
    account = make_user()
    client.cookies.clear()
    wrong = client.post("/api/v1/devices/login", json=_login(account, password="outra-senha-qualquer"))
    unknown = client.post("/api/v1/devices/login", json=_login(account, email="ninguem@exemplo.com.br"))
    browser = client.post("/api/v1/auth/login", json={"email": account.email, "password": "outra-senha-qualquer"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json()["detail"] == unknown.json()["detail"] == browser.json()["detail"]
    for body in (_login(account, platform="palm"), _login(account, device_name=""), _login(account, email="x")):
        assert client.post("/api/v1/devices/login", json=body).status_code == 422


@pytest.mark.parametrize(
    ("path", "body"),
    [
        (
            "/api/v1/devices/login",
            {"email": "x@exemplo.com.br", "password": "p", "device_name": "d", "platform": "ios"},
        ),
        ("/api/v1/devices/pair", {"code": "ZZZZZZ", "device_name": "d", "platform": "ios"}),
        ("/api/v1/auth/login", {"email": "x@exemplo.com.br", "password": "p"}),
        ("/api/v1/admin/auth/login", {"email": "x@exemplo.com.br", "password": "p"}),
        (
            "/api/v1/auth/signup",
            {"name": "N", "email": "x@exemplo.com.br", "password": "curta", "notice_version": "1"},
        ),
    ],
)
def test_tentativas_demais_do_mesmo_ip_sao_429(limited: TestClient, path: str, body: dict[str, Any]):
    statuses = [limited.post(path, json=body).status_code for _ in range(3)]
    assert 429 not in statuses  # as 3 primeiras passam (401 ou 422)
    blocked = limited.post(path, json=body)
    assert blocked.status_code == 429
    assert blocked.json()["code"] == "rate_limited"
    assert 1 <= int(blocked.headers["Retry-After"]) <= 60
    # Cada rota conta a sua janela.
    other = "/api/v1/devices/login" if path != "/api/v1/devices/login" else "/api/v1/auth/login"
    assert limited.post(other, json={}).status_code == 422


def _pair(code: str, **changes: Any) -> dict[str, Any]:  # noqa: ANN401
    return {"code": code, "device_name": "iPhone da Mariana", "platform": "ios"} | changes


def test_codigo_de_pareamento_vira_o_token_do_aparelho(
    client: TestClient, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user()
    session = as_user(account)
    created = session.post("/api/v1/devices/pairing-codes")
    assert created.status_code == 201
    code = created.json()
    assert re.fullmatch(r"[2-9A-HJKMNP-TV-Z]{6}", code["code"])
    assert code["display"] == f"{code['code'][:3]}-{code['code'][3:]}"
    assert (code["status"], code["token_id"]) == ("pending", None)
    assert code["pair_url"] == f"https://testserver/parear?codigo={code['code']}"
    # Só o HMAC fica no banco.
    stored = _sql(services, "SELECT code_hmac FROM pairing_codes WHERE id = :id", id=code["id"])
    assert code["code"] not in stored[0][0]

    client.cookies.clear()
    typed = code["display"].lower().replace("-", " - ")
    paired = client.post("/api/v1/devices/pair", json=_pair(typed))
    assert paired.status_code == 201
    token = paired.json()["token"]
    assert (token["name"], token["kind"], token["platform"]) == ("iPhone da Mariana", "device", "ios")
    assert Api(client, token=paired.json()["secret"]).get("/api/v1/me").json()["user"]["id"] == str(account.user_id)

    state = session.get(f"/api/v1/devices/pairing-codes/{code['id']}").json()
    assert (state["status"], state["token_id"]) == ("used", token["id"])
    assert "code" not in state
    # Uso único.
    again = client.post("/api/v1/devices/pair", json=_pair(code["code"]))
    assert (again.status_code, again.json()["code"]) == (401, "invalid_pairing_code")


def test_codigo_vencido_novo_ou_de_outra_conta(
    client: TestClient, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    alice, bob = make_user(), make_user()
    session = as_user(alice)
    first = session.post("/api/v1/devices/pairing-codes").json()
    second = session.post("/api/v1/devices/pairing-codes").json()
    # O código novo vence o anterior.
    assert session.get(f"/api/v1/devices/pairing-codes/{first['id']}").json()["status"] == "expired"
    _sql(services, "UPDATE pairing_codes SET expires_at = now() - interval '1 second' WHERE id = :id", id=second["id"])
    assert session.get(f"/api/v1/devices/pairing-codes/{second['id']}").json()["status"] == "expired"
    client.cookies.clear()
    for code in (first["code"], second["code"], "ZZZZZZ"):
        response = client.post("/api/v1/devices/pair", json=_pair(code))
        assert (response.status_code, response.json()["code"]) == (401, "invalid_pairing_code")
    # O código é da conta: outra conta não o vê.
    assert as_user(bob).get(f"/api/v1/devices/pairing-codes/{first['id']}").status_code == 404
    # Só sessão.
    pat = session.pat("recordings:read")
    assert pat.post("/api/v1/devices/pairing-codes").json()["code"] == "session_required"


def _sql(services: Services, sql: str, **params: Any) -> Any:  # noqa: ANN401
    async def go(conn: Any) -> Any:  # noqa: ANN401
        result = await conn.execute(text(sql), params)
        return result.all() if result.returns_rows else None

    return run(services.sql(go))
