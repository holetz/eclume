"""Fixtures da suíte do server.

Sem os serviços de `deploy/docker-compose.test.yml`, os testes que os pedem pulam — a não ser com
`ECLUME_TEST_REQUIRE_SERVICES=1` (a CI), em que a ausência vira falha, para que "pulou" nunca
passe por "passou".
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update

from eclume_server.accounts import NOTICE_VERSION
from eclume_server.app import create_app
from eclume_server.db import tables as t
from eclume_server_testing.api import Account, Api, admin_login, login, new_admin, new_user
from eclume_server_testing.conformance import CONFORMANCE
from eclume_server_testing.harness import REQUIRE_SERVICES, Services, provision, run, teardown, unreachable_services

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

_BLOCKS = (
    t.platform_settings.c.asr,
    t.platform_settings.c.diarization,
    t.platform_settings.c.preprocessing,
    t.platform_settings.c.voice_identification,
)


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
        # Toda resposta de /api/v1 da suíte é conferida contra o contrato bundled.
        test_client.event_hooks["response"] = [CONFORMANCE.check]
        yield test_client


@pytest.fixture(autouse=True)
def _conformance() -> Iterator[None]:
    """Falha o teste cujas respostas saíram do contrato."""
    CONFORMANCE.failures.clear()
    yield
    failures = list(CONFORMANCE.failures)
    CONFORMANCE.failures.clear()
    assert failures == [], "respostas fora do contrato:\n" + "\n".join(failures)


@pytest.fixture
def make_user(services: Services) -> Callable[..., Account]:
    """Fábrica de contas de usuário."""

    def make(*, name: str | None = None, notice_version: str | None = NOTICE_VERSION) -> Account:
        return new_user(services, name=name, notice_version=notice_version)

    return make


@pytest.fixture(scope="session")
def _platform_defaults(services: Services) -> dict[str, Any]:
    """A configuração da plataforma como a migration a deixou."""

    async def read(conn: Any) -> dict[str, Any]:  # noqa: ANN401
        return dict((await conn.execute(select(*_BLOCKS))).mappings().one())

    return run(services.sql(read))


@pytest.fixture
def platform(services: Services, _platform_defaults: dict[str, Any]) -> Iterator[None]:
    """Plataforma (configuração, segredos e providers) nos padrões da migration, antes e depois.

    A plataforma é uma só no banco da sessão: o teste que a muda não vaza para os outros.
    """

    async def reset(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(update(t.platform_settings).values(**_platform_defaults, updated_by=None))
        await conn.execute(delete(t.platform_secrets))
        await conn.execute(delete(t.agent_providers))

    run(services.sql(reset))
    yield
    run(services.sql(reset))


@pytest.fixture
def admin(services: Services, client: TestClient, platform: None) -> Api:
    """Sessão de admin de uma conta de admin nova, com a plataforma nos padrões."""
    del platform
    return admin_login(client, new_admin(services).email)


@pytest.fixture
def as_user(client: TestClient) -> Callable[[Account], Api]:
    """Sessão aberta para uma conta."""

    def open_session(account: Account) -> Api:
        return login(client, account.email)

    return open_session
