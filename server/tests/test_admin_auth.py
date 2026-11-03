"""Admin account: login, its own session, the boundary with user credentials, and logout."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import text

from eclume_server_testing.api import PASSWORD, Api, admin_login, audio_bytes, new_admin, upload_file
from eclume_server_testing.fakes import run_cpu, run_gpu
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi.testclient import TestClient

    from eclume_server_testing.api import Account
    from eclume_server_testing.harness import Services


def test_admin_login_sets_its_own_cookies(client: TestClient, services: Services):
    account = new_admin(services)
    client.cookies.clear()
    response = client.post("/api/v1/admin/auth/login", json={"email": account.email.upper(), "password": PASSWORD})
    assert response.status_code == 204
    set_cookie = response.headers.get_list("set-cookie")
    session = next(c for c in set_cookie if c.startswith("eclume_admin_session="))
    csrf = next(c for c in set_cookie if c.startswith("eclume_admin_csrf="))
    assert "HttpOnly" in session
    assert "Secure" in session
    assert "samesite=strict" in session.lower()
    assert "Path=/api/v1/admin" in session
    assert "HttpOnly" not in csrf
    api = Api(
        client,
        cookies={name: response.cookies[name] for name in ("eclume_admin_session", "eclume_admin_csrf")},
        csrf_cookie="eclume_admin_csrf",
    )
    me = api.get("/api/v1/admin/me").json()
    assert me["email"] == account.email
    assert me["last_login_at"] is not None


def test_wrong_admin_login_is_401(client: TestClient, services: Services, make_user: Callable[..., Account]):
    account = new_admin(services)
    client.cookies.clear()
    wrong = client.post("/api/v1/admin/auth/login", json={"email": account.email, "password": "outra-senha-qualquer"})
    assert wrong.status_code == 401
    # A user account does not enter the panel, not even with the right password.
    user = make_user()
    as_user = client.post("/api/v1/admin/auth/login", json={"email": user.email, "password": PASSWORD})
    assert as_user.status_code == 401


def test_admin_session_reaches_only_the_panel(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    assert admin.get("/api/v1/admin/users").status_code == 200
    # Outside /admin/*, the admin cookie is ignored: without a user credential, 401.
    for url in ("/api/v1/me", "/api/v1/recordings", "/api/v1/people"):
        assert admin.get(url).status_code == 401, url

    user = as_user(make_user())
    pat = user.pat("recordings:read")
    for api in (user, pat, Api(admin.client)):
        for url in ("/api/v1/admin/me", "/api/v1/admin/users", "/api/v1/admin/settings", "/api/v1/admin/health"):
            response = api.get(url)
            assert response.status_code == 401, url
            assert response.json()["code"] == "unauthorized"


def test_admin_session_csrf(admin: Api):
    admin.send_csrf = False
    response = admin.patch("/api/v1/admin/settings", json={"asr": {"model": "large-v3"}})
    assert response.status_code == 401
    assert "eclume_admin_csrf" in response.json()["detail"]
    admin.send_csrf = True
    assert admin.patch("/api/v1/admin/settings", json={"asr": {"model": "large-v3"}}).status_code == 200


def test_admin_logout_ends_the_session(admin: Api):
    assert admin.post("/api/v1/admin/auth/logout").status_code == 204
    assert admin.get("/api/v1/admin/me").status_code == 401


def test_deactivated_admin_cannot_enter(client: TestClient, services: Services):
    account = new_admin(services)
    session = admin_login(client, account.email)

    async def deactivate(conn):  # noqa: ANN001, ANN202
        await conn.execute(text("UPDATE admins SET active = false WHERE id = :id"), {"id": account.user_id})

    run(services.sql(deactivate))
    assert session.get("/api/v1/admin/me").status_code == 401
    client.cookies.clear()
    login = client.post("/api/v1/admin/auth/login", json={"email": account.email, "password": PASSWORD})
    assert login.status_code == 401


def test_quota_usage_and_override_in_users(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user()
    api = as_user(account)
    upload_file(api, audio_bytes(4096, seed="uso-admin"))
    url = f"/api/v1/admin/users/{account.user_id}"

    def listed() -> dict[str, Any]:
        pages = admin.get("/api/v1/admin/users").json()["items"]
        return next(item for item in pages if item["id"] == str(account.user_id))

    row = listed()
    assert row["quotas"] is None
    assert (row["usage"]["storage_bytes"], row["usage"]["open_uploads"]) == (4096, 0)

    changed = admin.patch(url, json={"quotas": {"storage_bytes": 1000, "gpu_minutes_24h": None}})
    assert changed.status_code == 200, changed.text
    assert changed.json()["quotas"] == {"storage_bytes": 1000, "gpu_minutes_24h": None}
    assert changed.json()["active"] is True
    effective = api.get("/api/v1/me/usage").json()["quotas"]
    assert (effective["storage_bytes"], effective["gpu_minutes_24h"], effective["open_uploads"]) == (1000, None, 3)
    refused = api.post(
        "/api/v1/uploads",
        json={"filename": "a.opus", "content_type": "audio/ogg", "size_bytes": 10, "sha256": "0" * 64},
    )
    assert (refused.status_code, refused.json()["quota"]) == (403, "storage_bytes")

    assert admin.patch(url, json={"quotas": {"storage_bytes": -1}}).status_code == 422
    assert admin.patch(url, json={"quotas": {"outra": 1}}).status_code == 422
    assert admin.patch(url, json={}).status_code == 422
    assert admin.patch(url, json={"quotas": None}).json()["quotas"] is None
    assert listed()["quotas"] is None
    # The recording's transcription does not stay in the queue for another test's Health.
    run_gpu(services.settings)
    run_cpu(services.settings)
