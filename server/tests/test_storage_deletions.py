"""Fila de exclusão no bucket: gatilhos no banco, dreno com retentativa e reconciliação."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import text

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


def _queued(services: Services, recording_id: str) -> set[tuple[str | None, str | None]]:
    rows = _sql(
        services,
        "SELECT key, prefix FROM storage_deletions WHERE key LIKE '%' || :r || '%' OR prefix LIKE '%' || :r || '%'",
        r=recording_id,
    )
    return {(key, prefix) for key, prefix in rows}


def test_excluir_a_gravacao_enfileira_audio_e_artefatos_na_mesma_transacao(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(4200))
    audio_key = _sql(services, "SELECT audio_key FROM recordings WHERE id = :r", r=recording["id"])[0][0]
    assert _queued(services, recording["id"]) == set()
    assert api.delete(f"/api/v1/recordings/{recording['id']}").status_code == 204
    assert _queued(services, recording["id"]) == {(audio_key, None), (None, f"recordings/{recording['id']}/")}


def test_upload_em_andamento_da_conta_excluida_enfileira_o_abort(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], services: Services
):
    account = make_user()
    api = as_user(account)
    created = api.post(
        "/api/v1/uploads",
        json={"filename": "a.opus", "content_type": "audio/ogg; codecs=opus", "size_bytes": 1000, "sha256": "ab" * 32},
    )
    assert created.status_code == 201, created.text
    upload = _sql(services, "SELECT audio_key, s3_upload_id FROM uploads WHERE id = :u", u=created.json()["id"])[0]
    _sql(services, "DELETE FROM users WHERE id = :u", u=account.user_id)
    rows = _sql(
        services, "SELECT key, s3_upload_id FROM storage_deletions WHERE s3_upload_id = :s", s=upload.s3_upload_id
    )
    assert rows == [(upload.audio_key, upload.s3_upload_id)]
