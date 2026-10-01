"""`GET /privacy`: o destino de cada dado, classificado pelo servidor (holetz/eclume#116)."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from eclume_server.privacy import classify_asr, classify_provider, classify_url

if TYPE_CHECKING:
    from fastapi.testclient import TestClient

    from eclume_server_testing.api import Api

URL = "/api/v1/privacy"


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("http://localhost:11434", ("server", None)),
        ("http://127.0.0.1:8000/v1", ("server", None)),
        ("http://[::1]:8000", ("server", None)),
        ("http://ollama:11434", ("server", None)),
        ("http://host.docker.internal:11434", ("server", None)),
        ("http://192.168.15.20:11434", ("local_network", None)),
        ("http://10.1.2.3/v1", ("local_network", None)),
        ("http://172.20.0.5", ("local_network", None)),
        ("http://169.254.1.1", ("local_network", None)),
        ("http://[fd00::1]:8000", ("local_network", None)),
        ("http://gpu.lan:8000", ("local_network", None)),
        ("http://estacao.local", ("local_network", None)),
        ("https://api.deepseek.com/v1/chat?key=x", ("external", "api.deepseek.com")),
        ("https://API.Example.org:8443/x", ("external", "api.example.org")),
        ("http://8.8.8.8", ("external", "8.8.8.8")),
        ("http://172.32.0.1", ("external", "172.32.0.1")),
        (None, ("external", None)),
    ],
)
def test_classifica_o_endereco_sem_dns(url: str | None, expected: tuple[str, str | None]):
    assert classify_url(url) == expected


def test_anthropic_e_claude_cli_sempre_fora():
    assert classify_provider("anthropic", None) == ("external", "Anthropic")
    assert classify_provider("claude-cli", "http://localhost") == ("external", "Anthropic")
    assert classify_provider("ollama", "http://ollama:11434") == ("server", None)


def test_engine_local_no_servidor_e_remota_pelo_endereco():
    assert classify_asr({"engine": "whisperx-local"}) == ("server", None)
    assert classify_asr({"engine": "cpu"}) == ("server", None)
    remote = {"engine": "openai-compatible", "endpoint_url": "https://asr.example.com/v1"}
    assert classify_asr(remote) == ("external", "asr.example.com")


def _by_purpose(client: TestClient) -> dict[str, dict]:
    client.cookies.clear()
    response = client.get(URL)
    assert response.status_code == 200
    return {item["purpose"]: item for item in response.json()["destinations"]}


def test_padrao_tudo_no_servidor_e_agentes_desligados(admin: Api, client: TestClient):
    del admin
    destinations = _by_purpose(client)
    assert list(destinations) == ["transcription", "summaries", "fields", "chat", "agenda_detection"]
    assert destinations["transcription"] == {"purpose": "transcription", "location": "server", "processor": None}
    assert {item["location"] for purpose, item in destinations.items() if purpose != "transcription"} == {"disabled"}


def test_destinos_sem_endereco_chave_modelo_nem_nome(admin: Api, client: TestClient):
    admin.post(
        "/api/v1/admin/agent-providers",
        json={
            "name": "Claude da casa",
            "kind": "claude-cli",
            "model": "sonnet-segredo",
            "api_key": "sk-ant-oat01-segredo",
            "used_for": ["summaries", "chat"],
        },
    )
    admin.post(
        "/api/v1/admin/agent-providers",
        json={
            "name": "DeepSeek",
            "kind": "openai-compatible",
            "base_url": "https://api.deepseek.com/v1?token=abc",
            "model": "deepseek-chat",
            "api_key": "sk-segredo",
            "used_for": ["fields"],
        },
    )
    admin.post(
        "/api/v1/admin/agent-providers",
        json={
            "name": "Ollama desligado",
            "kind": "ollama",
            "base_url": "http://192.168.15.30:11434",
            "model": "qwen",
            "enabled": False,
            "used_for": ["agenda_detection"],
        },
    )
    admin.patch(
        "/api/v1/admin/settings",
        json={"asr": {"engine": "openai-compatible", "endpoint_url": "http://192.168.15.40:9000/v1"}},
    )
    client.cookies.clear()
    body = client.get(URL).text
    for secret in ("sonnet-segredo", "segredo", "deepseek-chat", "token=abc", "/v1", "Claude da casa", "9000"):
        assert secret not in body
    destinations = _by_purpose(client)
    assert destinations["summaries"]["location"] == "external"
    assert destinations["summaries"]["processor"] == "Anthropic"
    assert destinations["chat"]["processor"] == "Anthropic"
    assert destinations["fields"] == {"purpose": "fields", "location": "external", "processor": "api.deepseek.com"}
    assert destinations["agenda_detection"]["location"] == "disabled"
    assert destinations["transcription"] == {"purpose": "transcription", "location": "local_network", "processor": None}
