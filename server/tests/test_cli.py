"""CLI `eclume-server`: migrate e as contas de admin (`admin create`, `admin set-password`)."""

from __future__ import annotations

import io
import json
import secrets
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import uuid4

import redis
from sqlalchemy import make_url, text
from sqlalchemy.ext.asyncio import create_async_engine

from eclume_server import cli
from eclume_server.db.migrate import migration_files
from eclume_server_testing.api import admin_login, audio_bytes, upload_file
from eclume_server_testing.harness import DATABASE_URL, run

if TYPE_CHECKING:
    from collections.abc import Callable

    import pytest
    from fastapi.testclient import TestClient

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services


def _env(monkeypatch: pytest.MonkeyPatch, services: Services) -> None:
    monkeypatch.setenv("ECLUME_DATABASE_URL", services.settings.database_url)
    cli.get_settings.cache_clear()


def _run(monkeypatch: pytest.MonkeyPatch, stdin: str, *args: str) -> int:
    monkeypatch.setattr("sys.stdin", io.StringIO(stdin + "\n"))
    return cli.main(["admin", *args, "--password-stdin"])


def test_admin_create_cria_a_conta_que_entra_no_painel(
    monkeypatch: pytest.MonkeyPatch, services: Services, client: TestClient, capsys: pytest.CaptureFixture[str]
):
    _env(monkeypatch, services)
    email = f"admin-{secrets.token_hex(4)}@example.com"
    assert _run(monkeypatch, "uma-senha-bem-longa", "create", "--email", email, "--name", "Administrator") == 0
    assert capsys.readouterr().out.startswith("admin ")
    me = admin_login(client, email, "uma-senha-bem-longa").get("/api/v1/admin/me").json()
    assert me["email"] == email
    assert me["name"] == "Administrator"

    # E-mail repetido e senha curta saem com código 2.
    assert _run(monkeypatch, "uma-senha-bem-longa", "create", "--email", email.upper(), "--name", "X") == 2
    assert "já cadastrado" in capsys.readouterr().err
    other = f"admin-{secrets.token_hex(4)}@example.com"
    assert _run(monkeypatch, "curta", "create", "--email", other, "--name", "X") == 2


def test_admin_set_password_troca_a_senha_e_encerra_as_sessoes(
    monkeypatch: pytest.MonkeyPatch, services: Services, client: TestClient, capsys: pytest.CaptureFixture[str]
):
    _env(monkeypatch, services)
    email = f"admin-{secrets.token_hex(4)}@example.com"
    assert _run(monkeypatch, "senha-antiga-e-longa", "create", "--email", email, "--name", "Admin") == 0
    session = admin_login(client, email, "senha-antiga-e-longa")
    assert session.get("/api/v1/admin/me").status_code == 200

    assert _run(monkeypatch, "senha-nova-e-bem-longa", "set-password", "--email", email) == 0
    assert "sessões encerradas" in capsys.readouterr().out
    assert session.get("/api/v1/admin/me").status_code == 401
    old = client.post("/api/v1/admin/auth/login", json={"email": email, "password": "senha-antiga-e-longa"})
    assert old.status_code == 401
    assert admin_login(client, email, "senha-nova-e-bem-longa").get("/api/v1/admin/me").status_code == 200

    assert _run(monkeypatch, "senha-nova-e-bem-longa", "set-password", "--email", "ninguem@exemplo.com.br") == 2
    assert "inexistente" in capsys.readouterr().err


def _as_owner(services: Services, statement: str, **params: object) -> None:
    """Como o migrador (o papel de conexão não escreve em `schema_migrations`)."""

    async def go() -> None:
        engine = create_async_engine(make_url(DATABASE_URL).set(database=services.database))
        try:
            async with engine.begin() as conn:
                await conn.execute(text(statement), params)
        finally:
            await engine.dispose()

    run(go())


def test_migrate_pendentes_lista_sem_aplicar(
    monkeypatch: pytest.MonkeyPatch, services: Services, capsys: pytest.CaptureFixture[str]
):
    _env(monkeypatch, services)
    assert cli.main(["migrate", "--pendentes"]) == 0
    assert capsys.readouterr().out == ""
    latest = migration_files()[-1].stem
    _as_owner(services, "DELETE FROM schema_migrations WHERE version = :v", v=latest)
    try:
        assert cli.main(["migrate", "--pendentes"]) == 0
        assert capsys.readouterr().out.splitlines() == [latest]
        # Listar não aplica: segue pendente.
        assert cli.main(["migrate", "--pendentes"]) == 0
        assert capsys.readouterr().out.splitlines() == [latest]
    finally:
        _as_owner(services, "INSERT INTO schema_migrations (version) VALUES (:v)", v=latest)


def test_migrate_sem_pendencias(
    monkeypatch: pytest.MonkeyPatch, services: Services, capsys: pytest.CaptureFixture[str]
):
    _env(monkeypatch, services)
    assert cli.main(["migrate"]) == 0
    assert "nenhuma" in capsys.readouterr().out


def _sql(services: Services, statement: str, **params: object) -> Any:  # noqa: ANN401
    async def go(conn: Any) -> Any:  # noqa: ANN401
        result = await conn.execute(text(statement), params)
        return result.all() if result.returns_rows else None

    return run(services.sql(go))


def _make_legacy(services: Services, recording_id: str, *, finished: bool) -> tuple[str, str]:
    """Põe o áudio da gravação numa chave da época da organização, como as gravações antigas."""
    new_key = _sql(services, "SELECT audio_key FROM recordings WHERE id = :r", r=recording_id)[0][0]
    old_key = f"orgs/{uuid4()}/{new_key}"
    s3, bucket = services.s3(), services.settings.s3_bucket
    s3.copy_object(Bucket=bucket, Key=old_key, CopySource={"Bucket": bucket, "Key": new_key})
    s3.delete_object(Bucket=bucket, Key=new_key)
    _sql(services, "UPDATE recordings SET audio_key = :k WHERE id = :r", k=old_key, r=recording_id)
    if finished:
        _sql(services, "UPDATE transcription_jobs SET state = 'failed' WHERE recording_id = :r", r=recording_id)
    return old_key, new_key


def test_relocate_legacy_move_as_chaves_orgs_uma_vez(
    monkeypatch: pytest.MonkeyPatch,
    services: Services,
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    capsys: pytest.CaptureFixture[str],
):
    _env(monkeypatch, services)
    monkeypatch.setenv("ECLUME_S3_ENDPOINT", services.settings.s3_endpoint)
    monkeypatch.setenv("ECLUME_S3_BUCKET", services.settings.s3_bucket)
    monkeypatch.setenv("ECLUME_S3_ACCESS_KEY", services.settings.s3_access_key)
    monkeypatch.setenv("ECLUME_S3_SECRET_KEY", services.settings.s3_secret_key)
    cli.get_settings.cache_clear()
    api = as_user(make_user())
    data = audio_bytes(4600)
    legacy = upload_file(api, data)
    busy = upload_file(api, audio_bytes(4700))
    old_key, new_key = _make_legacy(services, legacy["id"], finished=True)
    busy_key, _ = _make_legacy(services, busy["id"], finished=False)

    assert cli.main(["storage", "relocate-legacy", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert f"moveria {old_key} → {new_key}" in out
    assert f"pulada {busy['id']}: transcrição em andamento" in out
    assert _sql(services, "SELECT audio_key FROM recordings WHERE id = :r", r=legacy["id"]) == [(old_key,)]

    assert cli.main(["storage", "relocate-legacy"]) == 0
    assert f"movida {old_key} → {new_key}" in capsys.readouterr().out
    assert _sql(services, "SELECT audio_key FROM recordings WHERE id = :r", r=legacy["id"]) == [(new_key,)]
    body = services.s3().get_object(Bucket=services.settings.s3_bucket, Key=new_key)["Body"].read()
    assert body == data
    # A chave antiga sai pela fila de exclusão; a da gravação em andamento fica.
    assert _sql(services, "SELECT count(*) FROM storage_deletions WHERE key = :k", k=old_key) == [(1,)]
    assert _sql(services, "SELECT audio_key FROM recordings WHERE id = :r", r=busy["id"]) == [(busy_key,)]

    # Idempotente: na segunda vez, nada a mover além da que segue em andamento.
    assert cli.main(["storage", "relocate-legacy"]) == 0
    assert "movida" not in capsys.readouterr().out


def test_sonda_fila_pela_chave_de_health_check(monkeypatch: pytest.MonkeyPatch, services: Services):
    monkeypatch.setenv("ECLUME_REDIS_URL", services.settings.redis_url)
    cli.get_settings.cache_clear()
    client = redis.Redis.from_url(services.settings.redis_url)
    client.delete("eclume:default:health-check")
    assert cli.main(["sonda", "fila", "default"]) == 1
    client.set("eclume:default:health-check", "j_complete=1", ex=16)
    try:
        assert cli.main(["sonda", "fila", "default"]) == 0
    finally:
        client.delete("eclume:default:health-check")
        cli.get_settings.cache_clear()


def test_token_validity_pelo_cadastro_da_chave_oat():
    now = datetime(2026, 10, 1, tzinfo=UTC)
    oat = {"name": "Claude", "key": "sk-ant-oat01-x", "key_set_at": now - timedelta(days=340)}
    api = {"name": "API", "key": "sk-ant-api03-x", "key_set_at": now - timedelta(days=400)}
    validity = cli.token_validity([api, oat], now)
    assert validity["status"] == "ok"
    assert validity["provider"] == "Claude"
    assert validity["days_left"] == 25
    assert cli.token_validity([api], now) == {"status": "unknown", "expires_at": None, "days_left": None}


def test_saude_json_resume_a_saude_e_o_token(
    monkeypatch: pytest.MonkeyPatch, services: Services, admin: Api, capsys: pytest.CaptureFixture[str]
):
    created = admin.post(
        "/api/v1/admin/agent-providers",
        json={"name": "Claude", "kind": "claude-cli", "model": "sonnet", "api_key": "sk-ant-oat01-x"},
    ).json()

    async def age(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(
            text("UPDATE agent_providers SET key_set_at = now() - interval '340 days' WHERE id = :id"),
            {"id": created["id"]},
        )

    run(services.sql(age))
    monkeypatch.setattr(cli, "get_settings", lambda: services.settings)
    assert cli.main(["saude", "--json"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["claude_token"]["days_left"] in {24, 25}
    assert set(report["summary"]) == {"queued_over_2h", "failed_last_24h", "provider_auth_last_24h", "services_down"}
    assert "services" in report["health"]
