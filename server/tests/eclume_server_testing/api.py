"""Per-user test client and account factories."""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from sqlalchemy import select, update

from eclume_server.accounts import NOTICE_VERSION, create_admin, create_user, new_password_hash
from eclume_server.db import tables as t
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from uuid import UUID

    import httpx
    from fastapi.testclient import TestClient

    from eclume_server_testing.harness import Services

PASSWORD = "senha-de-teste-123"
_MUTATING = {"POST", "PUT", "PATCH", "DELETE"}


@dataclass
class Api:
    """Requests as a user: by session (cookies + CSRF) or by PAT.

    The `TestClient` is a single one in the test session; each `Api` sends its own credentials and
    clears the shared cookie jar before each request.
    """

    client: TestClient
    cookies: dict[str, str] | None = None
    token: str | None = None
    send_csrf: bool = True
    # The admin session echoes its own CSRF cookie (`eclume_admin_csrf`).
    csrf_cookie: str = "eclume_csrf"

    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:  # noqa: ANN401
        """Request with this user's credentials."""
        headers = dict(kwargs.pop("headers", None) or {})
        if self.token:
            headers.setdefault("Authorization", f"Bearer {self.token}")
        if self.cookies:
            headers.setdefault("Cookie", "; ".join(f"{k}={v}" for k, v in self.cookies.items()))
            if self.send_csrf and method.upper() in _MUTATING:
                headers.setdefault("X-CSRF-Token", self.cookies[self.csrf_cookie])
        self.client.cookies.clear()
        return self.client.request(method, url, headers=headers, **kwargs)

    def get(self, url: str, **kwargs: Any) -> httpx.Response:  # noqa: ANN401, D102
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> httpx.Response:  # noqa: ANN401, D102
        return self.request("POST", url, **kwargs)

    def put(self, url: str, **kwargs: Any) -> httpx.Response:  # noqa: ANN401, D102
        return self.request("PUT", url, **kwargs)

    def patch(self, url: str, **kwargs: Any) -> httpx.Response:  # noqa: ANN401, D102
        return self.request("PATCH", url, **kwargs)

    def delete(self, url: str, **kwargs: Any) -> httpx.Response:  # noqa: ANN401, D102
        return self.request("DELETE", url, **kwargs)

    def pat(self, *scopes: str, name: str = "teste") -> Api:
        """Creates a PAT with the scopes (through this session) and returns an `Api` that uses it."""
        response = self.post("/api/v1/tokens", json={"name": name, "scopes": list(scopes)})
        assert response.status_code == 201, response.text
        return Api(self.client, token=response.json()["secret"])


@dataclass
class Account:
    """User (or admin) account created for a test."""

    user_id: UUID
    email: str
    name: str


def login(client: TestClient, email: str, password: str = PASSWORD) -> Api:
    """Opens a session and returns the `Api` with its cookies."""
    client.cookies.clear()
    response = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 204, response.text
    cookies = {name: response.cookies[name] for name in ("eclume_session", "eclume_csrf")}
    client.cookies.clear()
    return Api(client, cookies=cookies)


def admin_login(client: TestClient, email: str, password: str = PASSWORD) -> Api:
    """Opens the admin session and returns the `Api` with its cookies."""
    client.cookies.clear()
    response = client.post("/api/v1/admin/auth/login", json={"email": email, "password": password})
    assert response.status_code == 204, response.text
    cookies = {name: response.cookies[name] for name in ("eclume_admin_session", "eclume_admin_csrf")}
    client.cookies.clear()
    return Api(client, cookies=cookies, csrf_cookie="eclume_admin_csrf")


def new_user(services: Services, *, name: str | None = None, notice_version: str | None = NOTICE_VERSION) -> Account:
    """New user account, with the password `PASSWORD` and the notice accepted (`notice_version=None`: not accepted)."""
    handle = secrets.token_hex(4)
    email = f"user-{handle}@exemplo.com.br"
    name = name or f"Usuário {handle}"

    async def create(conn: Any) -> UUID:  # noqa: ANN401
        password_hash = await new_password_hash(PASSWORD)
        return await create_user(
            conn, email=email, name=name, password_hash=password_hash, notice_version=notice_version
        )

    return Account(user_id=run(services.sql(create)), email=email, name=name)


def new_admin(services: Services) -> Account:
    """New admin account, with the password `PASSWORD`."""
    handle = secrets.token_hex(4)
    email = f"admin-{handle}@exemplo.com.br"
    name = f"Admin {handle}"

    async def create(conn: Any) -> UUID:  # noqa: ANN401
        return await create_admin(conn, email=email, name=name, password=PASSWORD)

    return Account(user_id=run(services.sql(create)), email=email, name=name)


def agenda_types(services: Services, user_id: UUID) -> list[dict[str, Any]]:
    """Agenda types of the account, in list order, read by the connection role."""
    c = t.agenda_types.c
    query = select(t.agenda_types).where(c.owner_id == user_id).order_by(c.position, c.created_at, c.id)

    async def read(conn: Any) -> list[dict[str, Any]]:  # noqa: ANN401
        return [dict(row) for row in (await conn.execute(query)).mappings()]

    return run(services.sql(read))


def audio_bytes(size: int, seed: str = "") -> bytes:
    """Deterministic content, unique per `seed` (the hash changes with it)."""
    block = hashlib.sha256(f"eclume-audio-{seed}-{secrets.token_hex(8)}".encode()).digest()
    return (block * (size // len(block) + 1))[:size]


def put_parts(api: Api, upload: dict[str, Any], data: bytes, *, only: set[int] | None = None) -> list[dict[str, Any]]:
    """Uploads the parts through the received URLs and returns `[{part_number, etag}]`."""
    size = upload["part_size"]
    sent = []
    for part in upload["parts"]:
        number = part["part_number"]
        if only is not None and number not in only:
            continue
        chunk = data[(number - 1) * size : number * size]
        response = api.client.put(part["url"], content=chunk, headers=part["headers"])
        assert response.status_code == 200, response.text
        sent.append({"part_number": number, "etag": response.headers["ETag"]})
    return sent


def upload_file(api: Api, data: bytes, **fields: Any) -> dict[str, Any]:  # noqa: ANN401
    """Whole flow (create → parts → complete); returns the recording."""
    body = {
        "filename": "reuniao.opus",
        "content_type": "audio/ogg; codecs=opus",
        "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        **fields,
    }
    created = api.post("/api/v1/uploads", json=body)
    assert created.status_code == 201, created.text
    upload = created.json()
    parts = put_parts(api, upload, data)
    completed = api.post(f"/api/v1/uploads/{upload['id']}/complete", json={"parts": parts})
    assert completed.status_code == 201, completed.text
    return completed.json()


def override_quotas(services: Services, api: Api, quotas: dict[str, Any] | None) -> None:
    """Overrides the quotas of the `api` account (`users.quotas`; `None` returns to the default)."""
    user_id = api.get("/api/v1/me").json()["user"]["id"]

    async def write(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(update(t.users).where(t.users.c.id == user_id).values(quotas=quotas))

    run(services.sql(write))
