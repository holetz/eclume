"""Retenção mínima: sessões vencidas e uploads terminais antigos somem no cron `purge_expired`."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

from eclume_server.worker import purge_stale_rows
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services


def _sql(services: Services, statement: str, **params: Any) -> Any:  # noqa: ANN401
    async def go(conn: Any) -> Any:  # noqa: ANN401
        result = await conn.execute(text(statement), params)
        return result.all() if result.returns_rows else None

    return run(services.sql(go))


def _purge(services: Services, now: datetime) -> dict[str, int]:
    return run(services.sql(lambda conn: purge_stale_rows(conn, now)))


def test_sessoes_vencidas_e_uploads_terminais_antigos_somem(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user()
    api = as_user(account)
    recording = upload_file(api, audio_bytes(4400))
    data = audio_bytes(4500)
    body = {"filename": "a.opus", "content_type": "audio/ogg; codecs=opus", "size_bytes": len(data)}
    open_upload = api.post("/api/v1/uploads", json=body | {"sha256": hashlib.sha256(data).hexdigest()}).json()
    sessions = _sql(services, "SELECT count(*) FROM sessions WHERE user_id = :u", u=account.user_id)[0][0]
    assert sessions >= 1

    # Hoje: nada vence.
    _purge(services, datetime.now(UTC))
    assert api.get("/api/v1/me").status_code == 200
    assert admin.get("/api/v1/admin/me").status_code == 200

    # Daqui a 40 dias: as sessões venceram há mais de 1 dia, e o upload concluído passou dos 30.
    removed = _purge(services, datetime.now(UTC) + timedelta(days=40))
    assert removed["sessions"] >= 1
    assert removed["admin_sessions"] >= 1
    assert _sql(services, "SELECT count(*) FROM sessions WHERE user_id = :u", u=account.user_id) == [(0,)]
    statuses = dict(
        _sql(services, "SELECT status, count(*) FROM uploads WHERE owner_id = :u GROUP BY status", u=account.user_id)
    )
    # O em andamento fica (o cron `expire_uploads` o encerra antes); o concluído saiu, a gravação não.
    assert statuses == {"in_progress": 1}
    assert open_upload["status"] == "in_progress"
    assert _sql(services, "SELECT count(*) FROM recordings WHERE id = :r", r=recording["id"]) == [(1,)]
