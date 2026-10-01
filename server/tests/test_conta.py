"""A conta pelo próprio usuário: trocar a senha e excluir a conta com todos os dados."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
import redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from eclume_server.accounts import (
    NOTICE_VERSION,
    AccountError,
    create_password_reset,
    password_reset_info,
    reset_password,
)
from eclume_server_testing.api import PASSWORD, audio_bytes, upload_file
from eclume_server_testing.fakes import drain_storage
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi.testclient import TestClient

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

NEW_PASSWORD = "uma-senha-nova-bem-longa"


def test_trocar_a_senha_encerra_as_outras_sessoes(
    client: TestClient, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    account = make_user()
    api = as_user(account)
    other = as_user(account)

    wrong = api.post("/api/v1/me/password", json={"current_password": "errada", "new_password": NEW_PASSWORD})
    assert (wrong.status_code, wrong.json()["errors"][0]["field"]) == (422, "current_password")
    short = api.post("/api/v1/me/password", json={"current_password": PASSWORD, "new_password": "curta"})
    assert (short.status_code, short.json()["errors"][0]["field"]) == (422, "new_password")
    assert api.pat("recordings:read").post(
        "/api/v1/me/password", json={"current_password": PASSWORD, "new_password": NEW_PASSWORD}
    ).status_code in {401, 403}

    changed = api.post("/api/v1/me/password", json={"current_password": PASSWORD, "new_password": NEW_PASSWORD})
    assert changed.status_code == 204, changed.text
    assert api.get("/api/v1/me").status_code == 200
    assert other.get("/api/v1/me").status_code == 401
    client.cookies.clear()
    old = client.post("/api/v1/auth/login", json={"email": account.email, "password": PASSWORD})
    assert old.status_code == 401
    client.cookies.clear()
    new = client.post("/api/v1/auth/login", json={"email": account.email, "password": NEW_PASSWORD})
    assert new.status_code == 204


def test_excluir_a_conta_apaga_tudo_e_so_dela(
    client: TestClient, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user()
    api = as_user(account)
    bystander = as_user(make_user())
    recording = upload_file(api, audio_bytes(100))
    kept = upload_file(bystander, audio_bytes(100))
    api.post("/api/v1/people", json={"name": "Rafael"})
    key = f"users/{account.user_id}/recordings/{recording['id']}/audio"
    s3 = services.s3()
    assert s3.list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=key)["KeyCount"] == 1

    refused = api.post("/api/v1/me/delete", json={"password": "errada"})
    assert (refused.status_code, refused.json()["errors"][0]["field"]) == (422, "password")
    assert api.get(f"/api/v1/recordings/{recording['id']}").status_code == 200
    assert api.pat("recordings:read").post("/api/v1/me/delete", json={"password": PASSWORD}).status_code in {401, 403}

    deleted = api.post("/api/v1/me/delete", json={"password": PASSWORD})
    assert deleted.status_code == 204, deleted.text
    assert "eclume_session=" in deleted.headers.get("set-cookie", "")
    assert api.get("/api/v1/me").status_code == 401
    drain_storage(services.settings)
    assert s3.list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=key)["KeyCount"] == 0
    client.cookies.clear()
    assert client.post("/api/v1/auth/login", json={"email": account.email, "password": PASSWORD}).status_code == 401
    assert bystander.get(f"/api/v1/recordings/{kept['id']}").status_code == 200
    # O job em aberto da conta excluída é cancelado; o de outra conta, não.
    cache = redis.Redis.from_url(services.settings.redis_url)
    assert cache.exists(f"eclume:cancel:{recording['id']}:1")
    assert not cache.exists(f"eclume:cancel:{kept['id']}:1")


def test_trocar_a_senha_com_revoke_tokens_revoga_aparelhos_e_pats(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    account = make_user()
    api = as_user(account)
    kept = api.pat("recordings:read", name="mantido")
    body = {"current_password": PASSWORD, "new_password": NEW_PASSWORD}
    assert api.post("/api/v1/me/password", json=body).status_code == 204
    # Sem `revoke_tokens`, os tokens seguem valendo, como antes.
    assert kept.get("/api/v1/me").status_code == 200

    revoked = api.pat("recordings:read", name="revogado")
    device = api.post("/api/v1/devices/pairing-codes").json()
    paired = api.client.post(
        "/api/v1/devices/pair", json={"code": device["code"], "device_name": "Celular", "platform": "android"}
    )
    assert paired.status_code == 201, paired.text
    again = {"current_password": NEW_PASSWORD, "new_password": PASSWORD, "revoke_tokens": True}
    assert api.post("/api/v1/me/password", json=again).status_code == 204
    assert revoked.get("/api/v1/me").status_code == 401
    assert kept.get("/api/v1/me").status_code == 401
    device_api = type(api)(api.client, token=paired.json()["secret"])
    assert device_api.get("/api/v1/me").status_code == 401
    assert api.get("/api/v1/me").status_code == 200


def test_admin_exclui_a_conta_e_libera_o_email(
    admin: Api,
    client: TestClient,
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
):
    account = make_user()
    api = as_user(account)
    recording = upload_file(api, audio_bytes(100, seed="admin-exclui"))
    key = f"users/{account.user_id}/recordings/{recording['id']}/audio"

    assert as_user(make_user()).delete(f"/api/v1/admin/users/{account.user_id}").status_code == 401
    assert admin.delete(f"/api/v1/admin/users/{account.user_id}").status_code == 204
    assert admin.delete(f"/api/v1/admin/users/{account.user_id}").status_code == 404
    assert api.get("/api/v1/me").status_code == 401
    drain_storage(services.settings)
    s3 = services.s3()
    assert s3.list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=key)["KeyCount"] == 0
    assert redis.Redis.from_url(services.settings.redis_url).exists(f"eclume:cancel:{recording['id']}:1")

    client.cookies.clear()
    again = client.post(
        "/api/v1/auth/signup",
        json={"name": "De volta", "email": account.email, "password": PASSWORD, "notice_version": NOTICE_VERSION},
    )
    assert again.status_code == 204, again.text


def _secret(link: dict) -> str:
    return link["url"].split("#", 1)[1]


def test_link_de_redefinicao_e_de_uso_unico_e_encerra_as_sessoes(
    client: TestClient, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user()
    api = as_user(account)

    async def new_link(conn: object) -> dict:
        return await create_password_reset(conn, account.user_id, None, "https://eclume.test/")

    old = run(services.sql(new_link))
    link = run(services.sql(new_link))
    assert link["url"].startswith("https://eclume.test/redefinir-senha#")

    async def go() -> None:
        engine = create_async_engine(services.settings.database_url)
        try:
            # Um link novo vence o anterior; conferir não consome.
            assert await password_reset_info(engine, _secret(old)) is None
            info = await password_reset_info(engine, _secret(link))
            assert info == {"email": account.email, "expires_at": link["expires_at"]}
            with pytest.raises(AccountError):
                await reset_password(engine, _secret(link), "curta")
            assert await password_reset_info(engine, _secret(link)) is not None
            assert await reset_password(engine, _secret(link), NEW_PASSWORD)
            assert not await reset_password(engine, _secret(link), NEW_PASSWORD)
            assert await password_reset_info(engine, _secret(link)) is None
            assert await password_reset_info(engine, "inexistente") is None
        finally:
            await engine.dispose()

    run(go())
    assert api.get("/api/v1/me").status_code == 401
    client.cookies.clear()
    assert client.post("/api/v1/auth/login", json={"email": account.email, "password": NEW_PASSWORD}).status_code == 204

    expired = run(services.sql(new_link))

    async def expire(conn: object) -> None:
        await conn.execute(text("UPDATE password_resets SET expires_at = now() - interval '1 second'"))

    run(services.sql(expire))

    async def check() -> object:
        engine = create_async_engine(services.settings.database_url)
        try:
            return await password_reset_info(engine, _secret(expired))
        finally:
            await engine.dispose()

    assert run(check()) is None
