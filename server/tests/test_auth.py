"""Sessão, CSRF, `me` e PATs (escopos, só-sessão, revogação, expiração)."""

from __future__ import annotations

import asyncio
import secrets
import time
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from eclume_server import security
from eclume_server.app import create_app
from eclume_server.db.migrate import migrate
from eclume_server_testing.api import PASSWORD, Api
from eclume_server_testing.conformance import CONFORMANCE, bundle
from eclume_server_testing.harness import DATABASE_URL, run

if TYPE_CHECKING:
    from collections.abc import Callable

    import pytest
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server_testing.api import Account
    from eclume_server_testing.harness import Services


def test_health_sem_credencial(client: TestClient):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    # O server anuncia a versão do contrato a que conforma; fora de imagem de produção, sem commit.
    assert response.json()["contract_version"] == bundle()["info"]["version"]
    assert "commit" not in response.json()


def test_health_diz_o_commit_da_imagem(services: Services):
    settings = services.settings.model_copy(update={"commit": "2c93963a4f1e0b7d8c6e5f4a3b2c1d0e9f8a7b6c"})
    with TestClient(create_app(settings), base_url="https://testserver") as client:
        client.event_hooks["response"] = [CONFORMANCE.check]
        body = client.get("/api/v1/health").json()
    assert body["commit"] == "2c93963a4f1e0b7d8c6e5f4a3b2c1d0e9f8a7b6c"


def test_login_define_cookies_seguros_e_me_por_sessao(client: TestClient, make_user: Callable[..., Account]):
    user = make_user(notice_version=None)
    client.cookies.clear()
    response = client.post("/api/v1/auth/login", json={"email": user.email.upper(), "password": PASSWORD})
    assert response.status_code == 204
    set_cookie = response.headers.get_list("set-cookie")
    session = next(c for c in set_cookie if c.startswith("eclume_session="))
    csrf = next(c for c in set_cookie if c.startswith("eclume_csrf="))
    assert "HttpOnly" in session
    assert "Secure" in session
    assert "samesite=lax" in session.lower()
    assert "HttpOnly" not in csrf
    api = Api(
        client,
        cookies={"eclume_session": response.cookies["eclume_session"], "eclume_csrf": response.cookies["eclume_csrf"]},
    )
    me = api.get("/api/v1/me").json()
    assert me["user"]["email"] == user.email
    assert me["user"]["last_login_at"] is not None
    # Conta sem o aceite do aviso em vigor, como a migrada.
    assert me["notice_required"] is True
    assert me["user"]["notice_version"] is None
    assert me["auth"] == {"method": "session", "scopes": me["auth"]["scopes"], "token_id": None}
    assert len(me["auth"]["scopes"]) == 9


def test_login_errado_e_sem_credencial_sao_401(client: TestClient, make_user: Callable[..., Account]):
    user = make_user()
    client.cookies.clear()
    wrong = client.post("/api/v1/auth/login", json={"email": user.email, "password": "outra-senha-qualquer"})
    assert wrong.status_code == 401
    assert wrong.json()["code"] == "unauthorized"
    unknown = client.post("/api/v1/auth/login", json={"email": "ninguem@exemplo.com.br", "password": "x"})
    assert unknown.status_code == 401
    anonymous = client.get("/api/v1/me")
    assert anonymous.status_code == 401
    assert anonymous.headers["content-type"].startswith("application/problem+json")
    assert anonymous.headers["www-authenticate"] == 'Bearer realm="eclume"'
    invalid = client.post("/api/v1/auth/login", json={"email": "nao-e-email", "password": ""})
    assert invalid.status_code == 422
    assert {e["field"] for e in invalid.json()["errors"]} == {"email", "password"}


def test_csrf_obrigatorio_em_metodo_mutavel_com_sessao(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    api = as_user(make_user())
    api.send_csrf = False
    response = api.post("/api/v1/tokens", json={"name": "x", "scopes": ["transcripts:read"]})
    assert response.status_code == 401
    assert "X-CSRF-Token" in response.json()["detail"]
    wrong = api.post(
        "/api/v1/tokens", json={"name": "x", "scopes": ["transcripts:read"]}, headers={"X-CSRF-Token": "errado"}
    )
    assert wrong.status_code == 401
    assert api.get("/api/v1/me").status_code == 200  # GET não exige CSRF


def test_pat_regrava_last_used_at_so_depois_de_60_s(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    session = as_user(make_user())
    body = session.post("/api/v1/tokens", json={"name": "lumea", "scopes": ["people:read"]}).json()
    pat = Api(session.client, token=body["secret"])
    token_id = body["token"]["id"]

    def last_used() -> datetime:
        async def go(conn: AsyncConnection) -> datetime:
            return (
                await conn.execute(text("SELECT last_used_at FROM api_tokens WHERE id = :i"), {"i": token_id})
            ).scalar_one()

        return run(services.sql(go))

    assert pat.get("/api/v1/me").status_code == 200
    first = last_used()
    assert pat.get("/api/v1/me").status_code == 200
    assert last_used() == first  # menos de 60 s: sem escrita

    async def backdate(conn: AsyncConnection) -> None:
        await conn.execute(
            text("UPDATE api_tokens SET last_used_at = now() - interval '2 minutes' WHERE id = :i"), {"i": token_id}
        )

    run(services.sql(backdate))
    stale = last_used()
    assert pat.get("/api/v1/me").status_code == 200
    assert last_used() > stale


def test_logout_encerra_a_sessao(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    response = api.post("/api/v1/auth/logout")
    assert response.status_code == 204
    assert api.get("/api/v1/me").status_code == 401


def test_pat_criado_listado_usado_e_revogado(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    session = as_user(make_user())
    created = session.post(
        "/api/v1/tokens", json={"name": "lumea — importador", "scopes": ["transcripts:read", "people:read"]}
    )
    assert created.status_code == 201
    body = created.json()
    secret = body["secret"]
    assert secret.startswith("eclp_")
    assert body["token"]["prefix"] == secret[:9]
    pat = Api(session.client, token=secret)
    me = pat.get("/api/v1/me").json()
    assert me["auth"] == {
        "method": "pat",
        "scopes": ["transcripts:read", "people:read"],
        "token_id": body["token"]["id"],
    }

    listed = session.get("/api/v1/tokens").json()
    assert [item["id"] for item in listed["items"]] == [body["token"]["id"]]
    assert listed["items"][0]["last_used_at"] is not None
    assert "secret" not in listed["items"][0]

    assert session.delete(f"/api/v1/tokens/{body['token']['id']}").status_code == 204
    assert pat.get("/api/v1/me").status_code == 401
    revoked = session.get("/api/v1/tokens").json()["items"][0]
    assert revoked["revoked_at"] is not None


def test_pat_invalido_nunca_cai_para_o_cookie(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    session = as_user(make_user())
    response = session.get("/api/v1/me", headers={"Authorization": "Bearer eclp_naoexiste"})
    assert response.status_code == 401


def test_pat_nao_gere_pats_nem_alcanca_o_painel(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    pat = as_user(make_user()).pat("recordings:read", "recordings:write")
    response = pat.get("/api/v1/tokens")
    assert response.status_code == 403
    assert response.json()["code"] == "session_required"
    assert "só sessão" in response.json()["detail"]
    created = pat.post("/api/v1/tokens", json={"name": "x", "scopes": ["recordings:read"]})
    assert created.status_code == 403
    # O painel admin não é do usuário: nenhuma credencial dele passa por lá.
    assert pat.get("/api/v1/admin/users").status_code == 401


def test_pat_expirado_e_401(as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services):
    session = as_user(make_user())
    soon = (datetime.now(UTC) + timedelta(seconds=1)).isoformat()
    created = session.post("/api/v1/tokens", json={"name": "curto", "scopes": ["recordings:read"], "expires_at": soon})
    assert created.status_code == 201
    past = session.post(
        "/api/v1/tokens",
        json={"name": "passado", "scopes": ["recordings:read"], "expires_at": "2020-01-01T00:00:00Z"},
    )
    assert past.status_code == 422
    assert past.json()["errors"][0]["field"] == "expires_at"

    async def expire(conn):  # noqa: ANN001, ANN202
        await conn.execute(
            text("UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE id = :id"),
            {"id": created.json()["token"]["id"]},
        )

    run(services.sql(expire))
    assert Api(session.client, token=created.json()["secret"]).get("/api/v1/me").status_code == 401


def test_validacao_do_pat(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    session = as_user(make_user())
    for body in (
        {"name": "", "scopes": ["recordings:read"]},
        {"name": "x", "scopes": []},
        {"name": "x", "scopes": ["recordings:admin"]},
        {"name": "x", "scopes": ["recordings:read", "recordings:read"]},
    ):
        response = session.post("/api/v1/tokens", json=body)
        assert response.status_code == 422, body
        assert response.json()["code"] == "validation_failed"


def test_paginacao_dos_pats(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    session = as_user(make_user())
    ids = [
        session.post("/api/v1/tokens", json={"name": f"t{i}", "scopes": ["recordings:read"]}).json()["token"]["id"]
        for i in range(5)
    ]
    first = session.get("/api/v1/tokens", params={"limit": 2}).json()
    assert len(first["items"]) == 2
    seen = [item["id"] for item in first["items"]]
    cursor = first["next_cursor"]
    while cursor:
        page = session.get("/api/v1/tokens", params={"limit": 2, "cursor": cursor}).json()
        seen += [item["id"] for item in page["items"]]
        cursor = page["next_cursor"]
    assert seen == list(reversed(ids))
    assert session.get("/api/v1/tokens", params={"cursor": "lixo"}).status_code == 422
    assert session.get("/api/v1/tokens", params={"limit": 0}).status_code == 422


def test_tokens_tem_tipo_e_a_lista_filtra_por_tipo(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user()
    session = as_user(account)
    created = session.post("/api/v1/tokens", json={"name": "lumea", "scopes": ["transcripts:read"]}).json()["token"]
    assert (created["kind"], created["platform"]) == ("personal", None)

    async def device(conn):  # noqa: ANN001, ANN202
        await conn.execute(
            text(
                "INSERT INTO api_tokens (user_id, name, token_hash, prefix, scopes, kind, platform)"
                " VALUES (:u, 'iPhone', :h, 'eclp_abcd', ARRAY['recordings:read'], 'device', 'ios')"
            ),
            {"u": account.user_id, "h": secrets.token_hex(32)},
        )

    run(services.sql(device))
    devices = session.get("/api/v1/tokens", params={"kind": "device"}).json()["items"]
    assert [(d["name"], d["kind"], d["platform"]) for d in devices] == [("iPhone", "device", "ios")]
    personal = session.get("/api/v1/tokens", params={"kind": "personal"}).json()["items"]
    assert [d["id"] for d in personal] == [created["id"]]
    assert len(session.get("/api/v1/tokens").json()["items"]) == 2
    assert session.get("/api/v1/tokens", params={"kind": "outro"}).status_code == 422


def test_migration_015_concede_a_exclusao_a_quem_tinha_recordings_write(services: Services):
    del services  # só pela checagem dos serviços de teste
    database = f"eclume_mig015_{secrets.token_hex(4)}"
    target = DATABASE_URL.rsplit("/", 1)[0] + f"/{database}"
    user, writer, reader = uuid4(), uuid4(), uuid4()
    seed = f"""
INSERT INTO users (id, email, name, password_hash) VALUES ('{user}', 'u@exemplo.com.br', 'U', 'h');
INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scopes) VALUES
    ('{writer}', '{user}', 'desktop', 'h1', 'eclp_a', ARRAY['recordings:read', 'recordings:write']),
    ('{reader}', '{user}', 'lumea', 'h2', 'eclp_b', ARRAY['transcripts:read']);
"""  # noqa: S608

    async def admin(statement: str) -> None:
        engine = create_async_engine(DATABASE_URL, isolation_level="AUTOCOMMIT")
        try:
            async with engine.connect() as conn:
                await conn.execute(text(statement))
        finally:
            await engine.dispose()

    async def check() -> list[tuple[str, list[str], str]]:
        await admin(f'CREATE DATABASE "{database}"')
        engine = create_async_engine(target)
        try:
            await migrate(engine, until="014_gravacao_resumo")
            async with engine.connect() as conn:
                await (await conn.get_raw_connection()).driver_connection.execute(seed)
            assert await migrate(engine, until="015_dispositivos_e_mcp") == ["015_dispositivos_e_mcp"]
            async with engine.connect() as conn:
                rows = await conn.execute(text("SELECT name, scopes, kind FROM api_tokens ORDER BY name"))
                return [tuple(row) for row in rows]
        finally:
            await engine.dispose()
            await admin(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')

    assert run(check()) == [
        ("desktop", ["recordings:read", "recordings:write", "recordings:delete"], "personal"),
        ("lumea", ["transcripts:read"], "personal"),
    ]


def test_health_ready_com_tudo_no_ar(client: TestClient):
    response = client.get("/api/v1/health/ready")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "checks": [
            {"name": "postgres", "status": "ok"},
            {"name": "redis", "status": "ok"},
            {"name": "storage", "status": "ok"},
        ],
    }
    assert response.headers["x-request-id"]


def test_health_ready_503_nomeia_o_que_caiu(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    async def fora() -> None:
        raise ConnectionError

    monkeypatch.setattr(client.app.state.ctx.storage, "head_bucket", fora)
    response = client.get("/api/v1/health/ready")
    assert response.status_code == 503
    checks = {c["name"]: c["status"] for c in response.json()["checks"]}
    assert checks == {"postgres": "ok", "redis": "ok", "storage": "down"}
    assert response.json()["status"] == "down"


def test_argon2_lento_nao_trava_o_event_loop(
    services: Services, make_user: Callable[..., Account], monkeypatch: pytest.MonkeyPatch
):
    account = make_user()
    real = security.verify_password

    def slow(password_hash: str | None, password: str) -> bool:
        time.sleep(1.0)
        return real(password_hash, password)

    monkeypatch.setattr(security, "verify_password", slow)

    async def go() -> tuple[int, int, float]:
        app = create_app(services.settings)
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as client:
                login = asyncio.create_task(
                    client.post("/api/v1/auth/login", json={"email": account.email, "password": PASSWORD})
                )
                await asyncio.sleep(0.2)
                start = time.perf_counter()
                health = await client.get("/api/v1/health")
                elapsed = time.perf_counter() - start
                return (await login).status_code, health.status_code, elapsed

    login_status, health_status, elapsed = run(go())
    assert (login_status, health_status) == (204, 200)
    assert elapsed < 0.5
