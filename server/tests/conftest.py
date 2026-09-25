"""Fixtures da suíte do server.

Sem os serviços de `deploy/docker-compose.test.yml`, os testes que os pedem pulam — a não ser com
`ECLUME_TEST_REQUIRE_SERVICES=1` (a CI), em que a ausência vira falha, para que "pulou" nunca
passe por "passou".
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from fastapi.testclient import TestClient

from eclume_server.app import create_app
from eclume_server_testing.api import Account, Api, login, new_org, new_user
from eclume_server_testing.harness import REQUIRE_SERVICES, Services, provision, teardown, unreachable_services

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator
    from uuid import UUID


@pytest.fixture(scope="session")
def services() -> Iterator[Services]:
    missing = unreachable_services()
    if missing:
        message = (
            f"serviços de teste fora do ar ({', '.join(missing)}): "
            "docker compose -p eclume-test -f deploy/docker-compose.test.yml up -d --wait"
        )
        if REQUIRE_SERVICES:
            pytest.fail(message)
        pytest.skip(message)
    svc = provision()
    yield svc
    teardown(svc)


@pytest.fixture(scope="session")
def client(services: Services) -> Iterator[TestClient]:
    with TestClient(create_app(services.settings), base_url="https://testserver") as test_client:
        yield test_client


@pytest.fixture
def org(services: Services) -> UUID:
    """Organização nova para o teste."""
    return new_org(services)


@pytest.fixture
def make_org(services: Services) -> Callable[[], UUID]:
    """Fábrica de organizações adicionais (para testes entre organizações)."""
    return lambda: new_org(services, "Outra organização")


@pytest.fixture
def make_user(services: Services, org: UUID) -> Callable[..., Account]:
    """Fábrica de usuários (por padrão na organização do teste)."""

    def make(*, role: str = "member", org_id: UUID | None = None, name: str | None = None) -> Account:
        return new_user(services, org_id or org, role=role, name=name)

    return make


@pytest.fixture
def as_user(client: TestClient) -> Callable[[Account], Api]:
    """Sessão aberta para uma conta."""

    def open_session(account: Account) -> Api:
        return login(client, account.email)

    return open_session
