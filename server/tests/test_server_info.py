"""Descritor público `GET /server` e a impressão digital da CA raiz."""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi.testclient import TestClient

from eclume_server import __version__
from eclume_server.app import create_app
from eclume_server_testing.conformance import CONFORMANCE, bundle

if TYPE_CHECKING:
    from eclume_server_testing.harness import Services

CA = Path(__file__).parent / "fixtures" / "ca-teste.pem"
# `openssl x509 -in ca-teste.pem -outform DER | sha256sum`
CA_SHA256 = "b127358a576a7cd0e4d76b63271e80a7d168a412e635e10855fcde3f83a4dd20"


def _client(services: Services, **settings: object) -> TestClient:
    client = TestClient(create_app(services.settings.model_copy(update=settings)), base_url="https://testserver")
    client.event_hooks["response"] = [CONFORMANCE.check]
    return client


def test_descritor_sem_credencial_e_sem_ca(client: TestClient):
    client.cookies.clear()
    response = client.get("/api/v1/server")
    assert response.status_code == 200
    base = response.json()["url"]
    assert response.json() == {
        "name": "eclume",
        "url": base,
        "mcp_url": f"{base}/mcp",
        "ca_sha256": None,
        "ca_next_sha256": None,
        "version": __version__,
        "contract_version": bundle()["info"]["version"],
    }


def test_descritor_com_endereco_publico_nome_e_ca(services: Services):
    settings = {"public_url": "https://192.168.15.199:8443/", "server_name": "eclume-sala", "ca_file": str(CA)}
    with _client(services, **settings) as client:
        info = client.get("/api/v1/server").json()
    assert info["name"] == "eclume-sala"
    assert info["url"] == "https://192.168.15.199:8443"
    assert info["mcp_url"] == "https://192.168.15.199:8443/mcp"
    assert info["ca_sha256"] == CA_SHA256


def test_ca_publicada_depois_entra_sem_restart(services: Services, tmp_path: Path):
    ca = tmp_path / "eclume-root.crt"
    with _client(services, ca_file=str(ca)) as client:
        assert client.get("/api/v1/server").json()["ca_sha256"] is None
        ca.write_text("não é um PEM", encoding="utf-8")
        assert client.get("/api/v1/server").json()["ca_sha256"] is None
        shutil.copyfile(CA, ca)
        # O cache é pelo mtime: garante um mtime diferente do arquivo inválido.
        stat = ca.stat()
        os.utime(ca, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
        assert client.get("/api/v1/server").json()["ca_sha256"] == CA_SHA256


def test_proxima_raiz_anunciada_durante_a_rotacao(services: Services, tmp_path: Path):
    next_ca = tmp_path / "eclume-root-proxima.crt"
    with _client(services, ca_file=str(CA), ca_next_file=str(next_ca)) as client:
        assert client.get("/api/v1/server").json()["ca_next_sha256"] is None
        shutil.copyfile(CA, next_ca)
        info = client.get("/api/v1/server").json()
        assert info["ca_next_sha256"] == CA_SHA256
        # Na virada, o publish-ca apaga a próxima: o descritor deixa de anunciá-la.
        next_ca.unlink()
        assert client.get("/api/v1/server").json()["ca_next_sha256"] is None
