"""Cotas por conta: cota efetiva, uso em `GET /me/usage` e as recusas do `POST /uploads`."""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

from eclume_server.quotas import merge
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

KIB = 1024


def _override(services: Services, account: Account, quotas: dict[str, Any] | None) -> None:
    async def write(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(
            text("UPDATE users SET quotas = CAST(:q AS jsonb) WHERE id = :id"),
            {"q": json.dumps(quotas) if quotas is not None else None, "id": account.user_id},
        )

    run(services.sql(write))


def _create(api: Api, data: bytes) -> Any:  # noqa: ANN401
    return api.post(
        "/api/v1/uploads",
        json={
            "filename": "reuniao.opus",
            "content_type": "audio/ogg; codecs=opus",
            "size_bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        },
    )


def test_cota_efetiva_sobrepoe_campo_a_campo():
    default = {"storage_bytes": 10, "file_bytes": 5, "open_uploads": 3, "gpu_minutes_24h": 60}
    assert merge(default, {"file_bytes": None, "open_uploads": 1}) == {
        "storage_bytes": 10,
        "file_bytes": None,
        "open_uploads": 1,
        "gpu_minutes_24h": 60,
        "agent_requests_24h": None,
    }
    assert merge(default, None)["file_bytes"] == 5


def test_uso_da_conta(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    account = make_user()
    api = as_user(account)
    fresh = api.get("/api/v1/me/usage")
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["usage"] == {
        "storage_bytes": 0,
        "open_uploads": 0,
        "gpu_minutes_24h": 0,
        "agent_requests_24h": 0,
    }
    assert fresh.json()["quotas"]["open_uploads"] == 3

    data = audio_bytes(64 * KIB, seed="uso")
    upload_file(api, data)
    assert _create(api, audio_bytes(32 * KIB, seed="aberto")).status_code == 201
    usage = api.get("/api/v1/me/usage").json()["usage"]
    assert usage["storage_bytes"] == 96 * KIB
    assert usage["open_uploads"] == 1


def test_upload_recusado_por_cota(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user()
    api = as_user(account)

    _override(services, account, {"file_bytes": 16 * KIB})
    big = _create(api, audio_bytes(32 * KIB, seed="grande"))
    assert big.status_code == 403
    assert big.json() | {"detail": None} == big.json() | {
        "code": "quota_exceeded",
        "quota": "file_bytes",
        "limit": 16 * KIB,
        "used": 32 * KIB,
        "detail": None,
    }

    _override(services, account, {"open_uploads": 1})
    assert _create(api, audio_bytes(8 * KIB, seed="um")).status_code == 201
    second = _create(api, audio_bytes(8 * KIB, seed="dois"))
    assert second.status_code == 403
    assert (second.json()["quota"], second.json()["used"]) == ("open_uploads", 2)

    _override(services, account, {"open_uploads": None, "storage_bytes": 20 * KIB})
    full = _create(api, audio_bytes(16 * KIB, seed="tres"))
    assert full.status_code == 403
    assert (full.json()["quota"], full.json()["used"]) == ("storage_bytes", 24 * KIB)

    # Retomar o mesmo arquivo não é upload novo: não passa pela cota.
    assert _create(api, audio_bytes(8 * KIB, seed="um")).status_code == 201

    _override(services, account, None)
    assert _create(api, audio_bytes(16 * KIB, seed="tres")).status_code == 201
