"""CLI `eclume-server`: migrate e bootstrap da primeira organização e do admin."""

from __future__ import annotations

import io
import secrets
from typing import TYPE_CHECKING

from eclume_server import cli
from eclume_server_testing.api import login

if TYPE_CHECKING:
    import pytest
    from fastapi.testclient import TestClient

    from eclume_server_testing.harness import Services


def _env(monkeypatch: pytest.MonkeyPatch, services: Services) -> None:
    monkeypatch.setenv("ECLUME_DATABASE_URL", services.settings.database_url)
    cli.get_settings.cache_clear()


def test_bootstrap_cria_organizacao_e_admin_que_faz_login(
    monkeypatch: pytest.MonkeyPatch, services: Services, client: TestClient, capsys: pytest.CaptureFixture[str]
):
    _env(monkeypatch, services)
    email = f"admin-{secrets.token_hex(4)}@example.com"
    monkeypatch.setattr("sys.stdin", io.StringIO("uma-senha-bem-longa\n"))
    code = cli.main(
        [
            "admin",
            "bootstrap",
            "--org",
            "EK Consultoria",
            "--email",
            email,
            "--name",
            "Mariana Couto",
            "--password-stdin",
        ]
    )
    assert code == 0
    assert "organização" in capsys.readouterr().out
    me = login(client, email, "uma-senha-bem-longa").get("/api/v1/me").json()
    assert me["user"]["role"] == "admin"
    assert me["organization"]["name"] == "EK Consultoria"

    monkeypatch.setattr("sys.stdin", io.StringIO("uma-senha-bem-longa\n"))
    again = cli.main(["admin", "bootstrap", "--org", "Outra", "--email", email, "--name", "X", "--password-stdin"])
    assert again == 2
    assert "já cadastrado" in capsys.readouterr().err

    monkeypatch.setattr("sys.stdin", io.StringIO("curta\n"))
    member_email = f"membro-{secrets.token_hex(4)}@example.com"
    short = cli.main(
        [
            "admin",
            "create-user",
            "--org-id",
            me["organization"]["id"],
            "--email",
            member_email,
            "--name",
            "Rafael",
            "--password-stdin",
        ]
    )
    assert short == 2


def test_migrate_sem_pendencias(
    monkeypatch: pytest.MonkeyPatch, services: Services, capsys: pytest.CaptureFixture[str]
):
    _env(monkeypatch, services)
    assert cli.main(["migrate"]) == 0
    assert "nenhuma" in capsys.readouterr().out
