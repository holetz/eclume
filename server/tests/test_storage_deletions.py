"""Fila de exclusão no bucket: gatilhos no banco, dreno com retentativa e reconciliação."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from sqlalchemy import text

from eclume_server.db.session import make_engine
from eclume_server.storage import Storage
from eclume_server.storage_deletions import drain, reconcile, retry_delay
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


def _s3_keys(services: Services, prefix: str) -> list[str]:
    listed = services.s3().list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=prefix)
    return [obj["Key"] for obj in listed.get("Contents", [])]


def _run_with_engine(services: Services, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:  # noqa: ANN401
    async def go() -> Any:  # noqa: ANN401
        engine = make_engine(services.settings.database_url)
        try:
            return await fn(engine, *args, **kwargs)
        finally:
            await engine.dispose()

    return run(go())


def test_dreno_apaga_chave_prefixo_e_multipart_e_esvazia_a_fila(services: Services):
    s3, bucket = services.s3(), services.settings.s3_bucket
    tag = uuid4()
    key, prefix = f"users/{tag}/recordings/{tag}/audio", f"recordings/{tag}/"
    for name in (key, f"{prefix}r1/transcript.raw.json", f"{prefix}transcript.raw.json"):
        s3.put_object(Bucket=bucket, Key=name, Body=b"x")
    upload_id = s3.create_multipart_upload(Bucket=bucket, Key=f"users/{tag}/pendente")["UploadId"]
    _sql(
        services,
        "INSERT INTO storage_deletions (key, prefix, s3_upload_id) VALUES "
        "(:k, NULL, NULL), (NULL, :p, NULL), (:m, NULL, :u)",
        k=key,
        p=prefix,
        m=f"users/{tag}/pendente",
        u=upload_id,
    )
    storage = Storage(services.settings)
    while _run_with_engine(services, drain, storage):
        pass
    assert _s3_keys(services, f"users/{tag}/") == []
    assert _s3_keys(services, prefix) == []
    pending = s3.list_multipart_uploads(Bucket=bucket, Prefix=f"users/{tag}/").get("Uploads", [])
    assert pending == []
    assert (
        _sql(
            services, "SELECT count(*) FROM storage_deletions WHERE key LIKE :t OR prefix = :p", t=f"%{tag}%", p=prefix
        )[0][0]
        == 0
    )


class _BrokenStorage:
    async def delete_keys(self, _keys: list[str]) -> None:
        msg = "S3 fora do ar"
        raise ConnectionError(msg)


def test_falha_adia_com_espera_crescente_e_nunca_desiste(services: Services):
    key = f"users/{uuid4()}/quebrado"
    _sql(services, "INSERT INTO storage_deletions (key) VALUES (:k)", k=key)
    now = datetime.now(UTC) + timedelta(days=1)
    for attempt, delay in ((1, timedelta(minutes=1)), (2, timedelta(minutes=2)), (3, timedelta(minutes=4))):
        _run_with_engine(services, drain, _BrokenStorage(), now=now)
        row = _sql(
            services, "SELECT attempts, last_error, next_attempt_at FROM storage_deletions WHERE key = :k", k=key
        )[0]
        assert (row.attempts, row.next_attempt_at - now) == (attempt, delay)
        assert "S3 fora do ar" in row.last_error
        now = row.next_attempt_at
    assert retry_delay(20) == timedelta(hours=1)
    _run_with_engine(services, drain, Storage(services.settings), now=now)
    assert _sql(services, "SELECT count(*) FROM storage_deletions WHERE key = :k", k=key)[0][0] == 0


def test_reconciliacao_enfileira_so_os_orfaos_antigos(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    kept = upload_file(api, audio_bytes(4300))
    kept_key = _sql(services, "SELECT audio_key FROM recordings WHERE id = :r", r=kept["id"])[0][0]
    s3, bucket = services.s3(), services.settings.s3_bucket
    tag = uuid4()
    orphan_audio, orphan_prefix = f"users/{tag}/recordings/{tag}/audio", f"recordings/{tag}/"
    s3.put_object(Bucket=bucket, Key=orphan_audio, Body=b"x")
    s3.put_object(Bucket=bucket, Key=f"{orphan_prefix}r1/transcript.raw.json", Body=b"{}")
    orphan_upload = s3.create_multipart_upload(Bucket=bucket, Key=f"users/{tag}/pendente")["UploadId"]

    storage = Storage(services.settings)
    # Recentes demais: a margem de 24 h os protege.
    _run_with_engine(services, reconcile, storage)
    assert (
        _sql(
            services,
            "SELECT count(*) FROM storage_deletions WHERE key LIKE :t OR prefix = :p",
            t=f"%{tag}%",
            p=orphan_prefix,
        )[0][0]
        == 0
    )

    later = datetime.now(UTC) + timedelta(days=2)
    _run_with_engine(services, reconcile, storage, now=later)
    queued = {
        (row.key, row.prefix, row.s3_upload_id)
        for row in _sql(services, "SELECT key, prefix, s3_upload_id FROM storage_deletions")
    }
    assert (orphan_audio, None, None) in queued
    assert (None, orphan_prefix, None) in queued
    assert (f"users/{tag}/pendente", None, orphan_upload) in queued
    assert not any(kept_key in (key, prefix) for key, prefix, _ in queued)
    assert (None, f"recordings/{kept['id']}/", None) not in queued
    # Uma segunda passada não duplica.
    before = _sql(services, "SELECT count(*) FROM storage_deletions")[0][0]
    _run_with_engine(services, reconcile, storage, now=later)
    assert _sql(services, "SELECT count(*) FROM storage_deletions")[0][0] == before
