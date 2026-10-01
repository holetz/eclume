"""Credencial de dispositivo: login por e-mail e senha, código de pareamento e limite de tentativas."""

from __future__ import annotations

import re
import secrets
import subprocess
import sys
from typing import TYPE_CHECKING, Any
from uuid import uuid4

import pytest
import redis
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from eclume_server.app import create_app
from eclume_server.db.migrate import migrate
from eclume_server.ratelimit import PAIR_GLOBAL_FACTOR
from eclume_server.worker import purge_pairing_codes
from eclume_server_testing.api import PASSWORD, Api
from eclume_server_testing.conformance import CONFORMANCE
from eclume_server_testing.harness import DATABASE_URL, run

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from eclume_server_testing.api import Account
    from eclume_server_testing.harness import Services


def _login(account: Account, **changes: Any) -> dict[str, Any]:  # noqa: ANN401
    body = {"email": account.email, "password": PASSWORD, "device_name": "Notebook da Mariana", "platform": "windows"}
    return body | changes


@pytest.fixture
def limited(services: Services) -> Iterator[TestClient]:
    """App com 3 tentativas por minuto, sem as janelas que os outros testes abriram."""
    store = redis.Redis.from_url(services.settings.redis_url)
    for key in store.scan_iter("eclume:rl:*"):
        store.delete(key)
    settings = services.settings.model_copy(update={"credential_attempts_per_minute": 3})
    with TestClient(create_app(settings), base_url="https://testserver") as client:
        client.event_hooks["response"] = [CONFORMANCE.check]
        yield client


def test_login_de_dispositivo_emite_o_token_do_aparelho(
    client: TestClient, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    account = make_user()
    client.cookies.clear()
    response = client.post("/api/v1/devices/login", json=_login(account, email=account.email.upper()))
    assert response.status_code == 201
    credential = response.json()
    token = credential["token"]
    assert (token["name"], token["kind"], token["platform"]) == ("Notebook da Mariana", "device", "windows")
    assert token["scopes"] == ["recordings:read", "recordings:write", "transcripts:read", "summaries:read"]
    assert token["expires_at"] is None
    assert credential["server"]["url"] == "https://testserver"
    assert credential["server"]["mcp_url"] == "https://testserver/mcp"

    device = Api(client, token=credential["secret"])
    me = device.get("/api/v1/me").json()
    assert me["auth"] == {"method": "pat", "scopes": token["scopes"], "token_id": token["id"]}
    assert device.get("/api/v1/recordings").status_code == 200
    # O escopo `summaries:read` passa (o aviso com "Copiar" do desktop): 404 da gravação, não 403.
    assert device.get(f"/api/v1/recordings/{uuid4()}/summary").status_code == 404
    # `transcripts:read` passa (a pasta sincronizada do desktop): a lista responde 200, não 403.
    assert device.get("/api/v1/transcripts").status_code == 200

    # Aparece em "App móvel" e "App desktop", e desvincular desliga o aparelho.
    session = as_user(account)
    devices = session.get("/api/v1/tokens", params={"kind": "device"}).json()["items"]
    assert [d["id"] for d in devices] == [token["id"]]
    assert session.delete(f"/api/v1/tokens/{token['id']}").status_code == 204
    assert device.get("/api/v1/me").status_code == 401


def test_login_de_dispositivo_errado_e_401_como_o_login(client: TestClient, make_user: Callable[..., Account]):
    account = make_user()
    client.cookies.clear()
    wrong = client.post("/api/v1/devices/login", json=_login(account, password="outra-senha-qualquer"))
    unknown = client.post("/api/v1/devices/login", json=_login(account, email="ninguem@exemplo.com.br"))
    browser = client.post("/api/v1/auth/login", json={"email": account.email, "password": "outra-senha-qualquer"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json()["detail"] == unknown.json()["detail"] == browser.json()["detail"]
    for body in (_login(account, platform="palm"), _login(account, device_name=""), _login(account, email="x")):
        assert client.post("/api/v1/devices/login", json=body).status_code == 422


@pytest.mark.parametrize(
    ("path", "body"),
    [
        (
            "/api/v1/devices/login",
            {"email": "x@exemplo.com.br", "password": "p", "device_name": "d", "platform": "ios"},
        ),
        ("/api/v1/devices/pair", {"code": "ZZZZZZ", "device_name": "d", "platform": "ios"}),
        ("/api/v1/auth/login", {"email": "x@exemplo.com.br", "password": "p"}),
        ("/api/v1/admin/auth/login", {"email": "x@exemplo.com.br", "password": "p"}),
        (
            "/api/v1/auth/signup",
            {"name": "N", "email": "x@exemplo.com.br", "password": "curta", "notice_version": "1"},
        ),
    ],
)
def test_tentativas_demais_do_mesmo_ip_sao_429(limited: TestClient, path: str, body: dict[str, Any]):
    statuses = [limited.post(path, json=body).status_code for _ in range(3)]
    assert 429 not in statuses  # as 3 primeiras passam (401 ou 422)
    blocked = limited.post(path, json=body)
    assert blocked.status_code == 429
    assert blocked.json()["code"] == "rate_limited"
    assert 1 <= int(blocked.headers["Retry-After"]) <= 60
    # Cada rota conta a sua janela.
    other = "/api/v1/devices/login" if path != "/api/v1/devices/login" else "/api/v1/auth/login"
    assert limited.post(other, json={}).status_code == 422


def test_troca_de_codigo_tem_teto_global(limited: TestClient, services: Services):
    store = redis.Redis.from_url(services.settings.redis_url)
    store.set("eclume:rl:devices_pair:*", 3 * PAIR_GLOBAL_FACTOR, ex=60)
    blocked = limited.post("/api/v1/devices/pair", json={"code": "ZZZZZZ", "device_name": "d", "platform": "ios"})
    assert (blocked.status_code, blocked.json()["code"]) == (429, "rate_limited")


def test_login_de_dispositivo_exige_o_aviso_aceito(client: TestClient, make_user: Callable[..., Account]):
    account = make_user(notice_version=None)
    client.cookies.clear()
    response = client.post("/api/v1/devices/login", json=_login(account))
    assert (response.status_code, response.json()["code"]) == (403, "notice_required")


def _pair(code: str, **changes: Any) -> dict[str, Any]:  # noqa: ANN401
    return {"code": code, "device_name": "iPhone da Mariana", "platform": "ios"} | changes


def test_codigo_de_pareamento_vira_o_token_do_aparelho(
    client: TestClient, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user()
    session = as_user(account)
    created = session.post("/api/v1/devices/pairing-codes")
    assert created.status_code == 201
    code = created.json()
    assert re.fullmatch(r"[2-9A-HJKMNP-TV-Z]{6}", code["code"])
    assert code["display"] == f"{code['code'][:3]}-{code['code'][3:]}"
    assert (code["status"], code["token_id"]) == ("pending", None)
    assert code["pair_url"] == f"https://testserver/parear?codigo={code['code']}"
    # Só o HMAC fica no banco.
    stored = _sql(services, "SELECT code_hmac FROM pairing_codes WHERE id = :id", id=code["id"])
    assert code["code"] not in stored[0][0]

    client.cookies.clear()
    typed = code["display"].lower().replace("-", " - ")
    paired = client.post("/api/v1/devices/pair", json=_pair(typed))
    assert paired.status_code == 201
    token = paired.json()["token"]
    assert (token["name"], token["kind"], token["platform"]) == ("iPhone da Mariana", "device", "ios")
    assert Api(client, token=paired.json()["secret"]).get("/api/v1/me").json()["user"]["id"] == str(account.user_id)

    state = session.get(f"/api/v1/devices/pairing-codes/{code['id']}").json()
    assert (state["status"], state["token_id"]) == ("used", token["id"])
    assert "code" not in state
    # Uso único.
    again = client.post("/api/v1/devices/pair", json=_pair(code["code"]))
    assert (again.status_code, again.json()["code"]) == (401, "invalid_pairing_code")


def test_codigo_vencido_novo_ou_de_outra_conta(
    client: TestClient, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    alice, bob = make_user(), make_user()
    session = as_user(alice)
    first = session.post("/api/v1/devices/pairing-codes").json()
    second = session.post("/api/v1/devices/pairing-codes").json()
    # O código novo vence o anterior.
    assert session.get(f"/api/v1/devices/pairing-codes/{first['id']}").json()["status"] == "expired"
    _sql(services, "UPDATE pairing_codes SET expires_at = now() - interval '1 second' WHERE id = :id", id=second["id"])
    assert session.get(f"/api/v1/devices/pairing-codes/{second['id']}").json()["status"] == "expired"
    client.cookies.clear()
    for code in (first["code"], second["code"], "ZZZZZZ"):
        response = client.post("/api/v1/devices/pair", json=_pair(code))
        assert (response.status_code, response.json()["code"]) == (401, "invalid_pairing_code")
    # O código é da conta: outra conta não o vê.
    assert as_user(bob).get(f"/api/v1/devices/pairing-codes/{first['id']}").status_code == 404
    # Só sessão.
    pat = session.pat("recordings:read")
    assert pat.post("/api/v1/devices/pairing-codes").json()["code"] == "session_required"
    # O cron apaga os vencidos sem uso há mais de um dia; o vencido de agora fica.
    _sql(services, "UPDATE pairing_codes SET expires_at = now() - interval '2 days' WHERE id = :id", id=first["id"])
    assert run(services.sql(purge_pairing_codes)) >= 1
    left = _sql(services, "SELECT id FROM pairing_codes WHERE id IN (:a, :b)", a=first["id"], b=second["id"])
    assert [str(row[0]) for row in left] == [second["id"]]


def _sql(services: Services, sql: str, **params: Any) -> Any:  # noqa: ANN401
    async def go(conn: Any) -> Any:  # noqa: ANN401
        result = await conn.execute(text(sql), params)
        return result.all() if result.returns_rows else None

    return run(services.sql(go))


def test_worker_importa_sozinho():
    """O worker sobe com `arq eclume_server.worker.WorkerSettings`, sem a API carregada antes."""
    result = subprocess.run(
        [sys.executable, "-c", "import eclume_server.worker"], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr


def test_migration_017_da_summaries_read_aos_dispositivos_ja_emitidos(services: Services):
    del services  # só pela checagem dos serviços de teste
    database = f"eclume_mig017_{secrets.token_hex(4)}"
    target = DATABASE_URL.rsplit("/", 1)[0] + f"/{database}"
    user = uuid4()
    seed = f"""
INSERT INTO users (id, email, name, password_hash) VALUES ('{user}', 'u@exemplo.com.br', 'U', 'h');
INSERT INTO api_tokens (user_id, name, token_hash, prefix, scopes, kind, platform) VALUES
    ('{user}', 'notebook', 'h1', 'eclp_a', ARRAY['recordings:read', 'recordings:write'], 'device', 'linux'),
    ('{user}', 'lumea', 'h2', 'eclp_b', ARRAY['transcripts:read'], 'personal', NULL);
"""  # noqa: S608

    async def admin(statement: str) -> None:
        engine = create_async_engine(DATABASE_URL, isolation_level="AUTOCOMMIT")
        try:
            async with engine.connect() as conn:
                await conn.execute(text(statement))
        finally:
            await engine.dispose()

    async def check() -> list[tuple[str, list[str]]]:
        await admin(f'CREATE DATABASE "{database}"')
        engine = create_async_engine(target)
        try:
            await migrate(engine, until="016_origem_mobile")
            async with engine.connect() as conn:
                await (await conn.get_raw_connection()).driver_connection.execute(seed)
            assert await migrate(engine, until="017_dispositivo_le_resumo") == ["017_dispositivo_le_resumo"]
            async with engine.connect() as conn:
                rows = await conn.execute(text("SELECT name, scopes FROM api_tokens ORDER BY name"))
                return [tuple(row) for row in rows]
        finally:
            await engine.dispose()
            await admin(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')

    assert run(check()) == [
        ("lumea", ["transcripts:read"]),
        ("notebook", ["recordings:read", "recordings:write", "summaries:read"]),
    ]


def test_migration_018_da_transcripts_read_aos_dispositivos_ja_emitidos(services: Services):
    del services  # só pela checagem dos serviços de teste
    database = f"eclume_mig018_{secrets.token_hex(4)}"
    target = DATABASE_URL.rsplit("/", 1)[0] + f"/{database}"
    user = uuid4()
    seed = f"""
INSERT INTO users (id, email, name, password_hash) VALUES ('{user}', 'u@exemplo.com.br', 'U', 'h');
INSERT INTO api_tokens (user_id, name, token_hash, prefix, scopes, kind, platform) VALUES
    ('{user}', 'notebook', 'h1', 'eclp_a', ARRAY['recordings:read', 'summaries:read'], 'device', 'linux'),
    ('{user}', 'lumea', 'h2', 'eclp_b', ARRAY['recordings:read'], 'personal', NULL);
"""  # noqa: S608

    async def admin(statement: str) -> None:
        engine = create_async_engine(DATABASE_URL, isolation_level="AUTOCOMMIT")
        try:
            async with engine.connect() as conn:
                await conn.execute(text(statement))
        finally:
            await engine.dispose()

    async def check() -> list[tuple[str, list[str]]]:
        await admin(f'CREATE DATABASE "{database}"')
        engine = create_async_engine(target)
        try:
            await migrate(engine, until="017_dispositivo_le_resumo")
            async with engine.connect() as conn:
                await (await conn.get_raw_connection()).driver_connection.execute(seed)
            assert await migrate(engine, until="018_dispositivo_le_transcricao") == ["018_dispositivo_le_transcricao"]
            async with engine.connect() as conn:
                rows = await conn.execute(text("SELECT name, scopes FROM api_tokens ORDER BY name"))
                return [tuple(row) for row in rows]
        finally:
            await engine.dispose()
            await admin(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')

    assert run(check()) == [
        ("lumea", ["recordings:read"]),
        ("notebook", ["recordings:read", "summaries:read", "transcripts:read"]),
    ]
