"""A conta pelo próprio usuário: trocar a senha e excluir a conta com todos os dados."""

from __future__ import annotations

from typing import TYPE_CHECKING

from eclume_server_testing.api import PASSWORD, audio_bytes, upload_file

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
    assert s3.list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=key)["KeyCount"] == 0
    client.cookies.clear()
    assert client.post("/api/v1/auth/login", json={"email": account.email, "password": PASSWORD}).status_code == 401
    assert bystander.get(f"/api/v1/recordings/{kept['id']}").status_code == 200
