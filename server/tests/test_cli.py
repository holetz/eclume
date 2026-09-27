"""CLI `eclume-server`: migrate e as contas de admin (`admin create`, `admin set-password`)."""

from __future__ import annotations

import io
import secrets
from typing import TYPE_CHECKING

from eclume_server import cli
from eclume_server_testing.api import admin_login

if TYPE_CHECKING:
    import pytest
    from fastapi.testclient import TestClient

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
    assert _run(monkeypatch, "uma-senha-bem-longa", "create", "--email", email, "--name", "Administração EK") == 0
    assert capsys.readouterr().out.startswith("admin ")
    me = admin_login(client, email, "uma-senha-bem-longa").get("/api/v1/admin/me").json()
    assert me["email"] == email
    assert me["name"] == "Administração EK"

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


def test_migrate_sem_pendencias(
    monkeypatch: pytest.MonkeyPatch, services: Services, capsys: pytest.CaptureFixture[str]
):
    _env(monkeypatch, services)
    assert cli.main(["migrate"]) == 0
    assert "nenhuma" in capsys.readouterr().out
