"""Fixtures da suíte do server.

Sem os serviços de `deploy/docker-compose.test.yml`, os testes que os pedem pulam — a não ser com
`ECLUME_TEST_REQUIRE_SERVICES=1` (a CI), em que a ausência vira falha, para que "pulou" nunca
passe por "passou".
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from eclume_server_testing.harness import REQUIRE_SERVICES, Services, provision, teardown, unreachable_services

if TYPE_CHECKING:
    from collections.abc import Iterator


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
