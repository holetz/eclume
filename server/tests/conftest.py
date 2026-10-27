"""Fixtures of the server suite.

Without the services of `deploy/docker-compose.test.yml`, the tests that request them skip — unless
`ECLUME_TEST_REQUIRE_SERVICES=1` (CI), where their absence becomes a failure, so that "skipped" never
passes for "passed".
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
    t.platform_settings.c.quotas,
)


@pytest.fixture(scope="session")
def services() -> Iterator[Services]:
    missing = unreachable_services()
    if missing:
        message = (
            f"test services are down ({', '.join(missing)}): "
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
        # Every /api/v1 response of the suite is checked against the bundled contract.
        test_client.event_hooks["response"] = [CONFORMANCE.check]
        yield test_client


@pytest.fixture(autouse=True)
def _conformance() -> Iterator[None]:
    """Fails the test whose responses left the contract."""
    CONFORMANCE.failures.clear()
    yield
    failures = list(CONFORMANCE.failures)
    CONFORMANCE.failures.clear()
    assert failures == [], "responses outside the contract:\n" + "\n".join(failures)


@pytest.fixture
def make_user(services: Services) -> Callable[..., Account]:
    """Factory of user accounts."""

    def make(*, name: str | None = None, notice_version: str | None = NOTICE_VERSION) -> Account:
        return new_user(services, name=name, notice_version=notice_version)

    return make


@pytest.fixture(scope="session")
def _platform_defaults(services: Services) -> dict[str, Any]:
    """The platform settings as the migration left them."""

    async def read(conn: Any) -> dict[str, Any]:  # noqa: ANN401
        return dict((await conn.execute(select(*_BLOCKS))).mappings().one())

    return run(services.sql(read))


@pytest.fixture
def platform(services: Services, _platform_defaults: dict[str, Any]) -> Iterator[None]:
    """Platform (settings, secrets and providers) at the migration defaults, before and after.

    The platform is a single one in the session database: the test that changes it does not leak
    into the others.
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
    """Admin session of a new admin account, with the platform at its defaults."""
    del platform
    return admin_login(client, new_admin(services).email)


@pytest.fixture
def as_user(client: TestClient) -> Callable[[Account], Api]:
    """Session opened for an account."""

    def open_session(account: Account) -> Api:
        return login(client, account.email)

    return open_session
