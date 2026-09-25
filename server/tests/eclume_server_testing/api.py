"""Cliente de teste por usuário e fábricas de contas."""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from eclume_server.accounts import create_org, create_user
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
    """Requisições como um usuário: por sessão (cookies + CSRF) ou por PAT.

    O `TestClient` é um só na sessão de testes; cada `Api` manda as próprias credenciais e limpa o
    cookie jar compartilhado antes de cada requisição.
    """

    client: TestClient
    cookies: dict[str, str] | None = None
    token: str | None = None
    send_csrf: bool = True

    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:  # noqa: ANN401
        """Requisição com as credenciais deste usuário."""
        headers = dict(kwargs.pop("headers", None) or {})
        if self.token:
            headers.setdefault("Authorization", f"Bearer {self.token}")
        if self.cookies:
            headers.setdefault("Cookie", "; ".join(f"{k}={v}" for k, v in self.cookies.items()))
            if self.send_csrf and method.upper() in _MUTATING:
                headers.setdefault("X-CSRF-Token", self.cookies["eclume_csrf"])
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
        """Cria um PAT com os escopos (por esta sessão) e devolve um `Api` que o usa."""
        response = self.post("/api/v1/tokens", json={"name": name, "scopes": list(scopes)})
        assert response.status_code == 201, response.text
        return Api(self.client, token=response.json()["secret"])


@dataclass
class Account:
    """Usuário criado para um teste."""

    org_id: UUID
    user_id: UUID
    email: str
    name: str


def login(client: TestClient, email: str, password: str = PASSWORD) -> Api:
    """Abre sessão e devolve o `Api` com os cookies dela."""
    client.cookies.clear()
    response = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 204, response.text
    cookies = {name: response.cookies[name] for name in ("eclume_session", "eclume_csrf")}
    client.cookies.clear()
    return Api(client, cookies=cookies)


def new_org(services: Services, name: str = "Organização de teste") -> UUID:
    """Organização nova (com a configuração padrão)."""

    async def create(conn: Any) -> UUID:  # noqa: ANN401
        return await create_org(conn, name)

    return run(services.sql(create))


def new_user(services: Services, org_id: UUID, *, role: str = "member", name: str | None = None) -> Account:
    """Usuário novo na organização, com a senha `PASSWORD`."""
    handle = secrets.token_hex(4)
    email = f"user-{handle}@exemplo.com.br"
    name = name or f"Usuário {handle}"

    async def create(conn: Any) -> UUID:  # noqa: ANN401
        return await create_user(conn, org_id, email=email, name=name, password=PASSWORD, role=role)

    return Account(org_id=org_id, user_id=run(services.sql(create)), email=email, name=name)


def audio_bytes(size: int, seed: str = "") -> bytes:
    """Conteúdo determinístico e único por `seed` (o hash muda com ele)."""
    block = hashlib.sha256(f"eclume-audio-{seed}-{secrets.token_hex(8)}".encode()).digest()
    return (block * (size // len(block) + 1))[:size]


def put_parts(api: Api, upload: dict[str, Any], data: bytes, *, only: set[int] | None = None) -> list[dict[str, Any]]:
    """Sobe as partes pelas URLs recebidas e devolve `[{part_number, etag}]`."""
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
    """Fluxo inteiro (create → partes → complete); devolve a gravação."""
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
