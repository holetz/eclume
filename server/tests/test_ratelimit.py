"""Login failure limit: (account, IP) pair, account ceiling that spares a known IP, success that resets."""

from __future__ import annotations

from contextlib import ExitStack
from typing import TYPE_CHECKING

import pytest
import redis
from fastapi.testclient import TestClient

from eclume_server.app import create_app
from eclume_server_testing.api import PASSWORD, new_admin
from eclume_server_testing.conformance import CONFORMANCE

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from eclume_server_testing.api import Account
    from eclume_server_testing.harness import Services

PER_PAIR = 3
PER_ACCOUNT = 5


@pytest.fixture
def from_ip(services: Services) -> Iterator[Callable[[str], TestClient]]:
    """One client per IP, all with 3 failures per pair and 5 per account, without other tests' windows."""
    store = redis.Redis.from_url(services.settings.redis_url)
    for key in store.scan_iter("eclume:rl:*"):
        store.delete(key)
    settings = services.settings.model_copy(
        update={"login_failures_per_pair": PER_PAIR, "login_failures_per_account": PER_ACCOUNT}
    )
    with ExitStack() as stack:
        clients: dict[str, TestClient] = {}

        def client(ip: str) -> TestClient:
            if ip not in clients:
                test_client = TestClient(create_app(settings), base_url="https://testserver", client=(ip, 50000))
                clients[ip] = stack.enter_context(test_client)
                clients[ip].event_hooks["response"] = [CONFORMANCE.check]
            return clients[ip]

        yield client


def _login(client: TestClient, email: str, password: str = PASSWORD, path: str = "/api/v1/auth/login") -> int:
    client.cookies.clear()
    body = {"email": email, "password": password}
    if path == "/api/v1/devices/login":
        body |= {"device_name": "d", "platform": "ios"}
    return client.post(path, json=body).status_code


def test_failures_from_one_ip_do_not_lock_out_the_account_owner(
    from_ip: Callable[[str], TestClient], make_user: Callable[..., Account]
):
    account = make_user()
    attacker = from_ip("10.0.0.1")
    assert [_login(attacker, account.email, "errada") for _ in range(PER_PAIR)] == [401] * PER_PAIR
    blocked = attacker.post("/api/v1/auth/login", json={"email": account.email, "password": PASSWORD})
    assert (blocked.status_code, blocked.json()["code"]) == (429, "rate_limited")
    assert 1 <= int(blocked.headers["Retry-After"]) <= 15 * 60
    assert _login(from_ip("10.0.0.2"), account.email) == 204


def test_browser_and_device_add_up_the_pair_failures(
    from_ip: Callable[[str], TestClient], make_user: Callable[..., Account]
):
    account = make_user()
    client = from_ip("10.0.1.1")
    assert _login(client, account.email, "errada") == 401
    assert _login(client, account.email, "errada", "/api/v1/devices/login") == 401
    assert _login(client, account.email, "errada") == 401
    assert _login(client, account.email, path="/api/v1/devices/login") == 429


def test_success_resets_the_pair_failures(from_ip: Callable[[str], TestClient], make_user: Callable[..., Account]):
    account = make_user()
    client = from_ip("10.0.2.1")
    assert [_login(client, account.email, "errada") for _ in range(PER_PAIR - 1)] == [401] * (PER_PAIR - 1)
    assert _login(client, account.email) == 204
    assert [_login(client, account.email, "errada") for _ in range(PER_PAIR - 1)] == [401] * (PER_PAIR - 1)
    assert _login(client, account.email) == 204


def test_account_ceiling_blocks_new_ip_and_spares_known_ip(
    from_ip: Callable[[str], TestClient], make_user: Callable[..., Account]
):
    account = make_user()
    known = from_ip("10.0.3.1")
    assert _login(known, account.email) == 204
    for n in range(PER_ACCOUNT):
        assert _login(from_ip(f"10.0.4.{n}"), account.email, "errada") == 401
    assert _login(from_ip("10.0.5.1"), account.email) == 429
    assert _login(known, account.email) == 204


def test_admin_has_its_own_counters(from_ip: Callable[[str], TestClient], services: Services):
    admin = new_admin(services)
    client = from_ip("10.0.6.1")
    # Failures on the user account with the same e-mail do not count for the admin.
    assert [_login(client, admin.email, "errada") for _ in range(PER_PAIR)] == [401] * PER_PAIR
    admin_path = "/api/v1/admin/auth/login"
    assert [_login(client, admin.email, "errada", admin_path) for _ in range(PER_PAIR)] == [401] * PER_PAIR
    assert _login(client, admin.email, path=admin_path) == 429
