"""Credencial de dispositivo: login por e-mail e senha, código de pareamento e limite de tentativas."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
import redis
from fastapi.testclient import TestClient

from eclume_server.app import create_app
from eclume_server_testing.api import PASSWORD, Api
from eclume_server_testing.conformance import CONFORMANCE

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
