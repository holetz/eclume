# ruff: noqa: INP001, S101, D103  # testes soltos do compose de produção; deploy/ não é pacote Python
"""Regressão do isolamento do compose de produção: credenciais, redes e limites por serviço."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
import yaml

COMPOSE = yaml.safe_load(Path(__file__).with_name("docker-compose.prod.yml").read_text(encoding="utf-8"))
SERVICES: dict[str, dict[str, Any]] = COMPOSE["services"]
CONFIGS: dict[str, dict[str, Any]] = COMPOSE["configs"]
ENV_EXAMPLE = Path(__file__).with_name(".env.prod.example").read_text(encoding="utf-8")

# Serviços da aplicação: nenhum vê a credencial root do MinIO.
APP = ("server", "worker-cpu", "worker-agents", "worker-gpu", "migrate", "mdns", "web", "caddy")
ROOT_USERS = ("minio", "minio-init")


def _env(service: str) -> dict[str, str]:
    return {key: str(value) for key, value in (SERVICES[service].get("environment") or {}).items()}


def _acl(user: str) -> str:
    content = CONFIGS["redis-conf"]["content"]
    match = re.search(rf"^user {re.escape(user)} (.*)$", content, re.MULTILINE)
    assert match, f"usuário {user} fora da ACL"
    return match.group(1)


@pytest.mark.parametrize("service", APP)
def test_credencial_root_do_minio_fora_da_aplicacao(service: str) -> None:
    values = " ".join(_env(service).values())
    assert "ECLUME_MINIO_USER" not in values
    assert "ECLUME_MINIO_PASSWORD}" not in values
    assert "ECLUME_MINIO_PASSWORD:" not in values


@pytest.mark.parametrize("service", ROOT_USERS)
def test_credencial_root_so_no_minio_e_no_init(service: str) -> None:
    assert "${ECLUME_MINIO_PASSWORD}" in _env(service).values()


@pytest.mark.parametrize(
    ("service", "redis_user", "s3_user", "s3_secret"),
    [
        ("server", "eclume-server", "eclume-server", "ECLUME_MINIO_SERVER_PASSWORD"),
        ("worker-cpu", "eclume-server", "eclume-server", "ECLUME_MINIO_SERVER_PASSWORD"),
        ("worker-agents", "eclume-server", "eclume-server", "ECLUME_MINIO_SERVER_PASSWORD"),
        ("worker-gpu", "eclume-gpu", "eclume-gpu", "ECLUME_MINIO_GPU_PASSWORD"),
    ],
)
def test_credencial_por_servico(service: str, redis_user: str, s3_user: str, s3_secret: str) -> None:
    env = _env(service)
    assert env["ECLUME_REDIS_URL"].startswith(f"redis://{redis_user}:")
    assert env["ECLUME_S3_ACCESS_KEY"] == s3_user
    assert s3_secret in env["ECLUME_S3_SECRET_KEY"]


def test_credencial_redis_default_desligado() -> None:
    assert re.search(r"^user default off$", CONFIGS["redis-conf"]["content"], re.MULTILINE)
    assert "redis-conf" in {c["source"] for c in SERVICES["redis"]["configs"]}


def test_credencial_redis_gpu_so_nas_chaves_dele() -> None:
    rules = _acl("eclume-gpu").split()
    keys = {rule for rule in rules if rule.startswith(("~", "%"))}
    assert keys == {"~arq:*", "~eclume:gpu*", "~eclume:default", "~eclume:progress:*", "%R~eclume:cancel:*"}
    assert {"-@dangerous", "-@admin"} <= set(rules)


def test_credencial_minio_gpu_sem_apagar_nem_listar() -> None:
    policy = CONFIGS["minio-policy-gpu"]["content"]
    actions = set(re.findall(r'"(s3:\w+)"', policy))
    assert actions == {"s3:GetObject", "s3:PutObject"}
    assert "eclume/users/*/recordings/*/audio" in policy
    assert "eclume/recordings/*" in policy


@pytest.mark.parametrize(
    "name",
    [
        "ECLUME_MINIO_SERVER_PASSWORD",
        "ECLUME_MINIO_GPU_PASSWORD",
        "ECLUME_REDIS_SERVER_PASSWORD",
        "ECLUME_REDIS_GPU_PASSWORD",
    ],
)
def test_credencial_nova_no_env_de_exemplo(name: str) -> None:
    assert re.search(rf"^{name}=troque-", ENV_EXAMPLE, re.MULTILINE)


NETWORKS: dict[str, dict[str, Any]] = COMPOSE["networks"]
PYTHON = ("server", "worker-cpu", "worker-agents", "worker-gpu", "migrate", "mdns")


def _networks(service: str) -> set[str]:
    return set(SERVICES[service].get("networks") or [])


def test_rede_worker_gpu_longe_do_postgres_do_server_e_da_web() -> None:
    gpu = _networks("worker-gpu")
    assert gpu == {"fila-gpu", "saida"}
    for other in ("postgres", "server", "web", "caddy"):
        assert not gpu & _networks(other), f"worker-gpu divide rede com {other}"


def test_rede_dados_e_fila_gpu_internas() -> None:
    assert NETWORKS["dados"].get("internal") is True
    assert NETWORKS["fila-gpu"].get("internal") is True
    for service in ("postgres", "redis", "minio"):
        assert _networks(service) <= {"dados", "fila-gpu"}, f"{service} fora das redes internas"


def test_rede_de_cada_servico_declarada() -> None:
    for name, service in SERVICES.items():
        assert service.get("networks") or service.get("network_mode"), f"{name} sem rede declarada"
    assert SERVICES["publish-ca"]["network_mode"] == "none"
    assert SERVICES["mdns"]["network_mode"] == "host"


@pytest.mark.parametrize("service", PYTHON)
def test_rede_conteiner_python_sem_capabilities(service: str) -> None:
    assert SERVICES[service]["cap_drop"] == ["ALL"]
    assert "no-new-privileges:true" in SERVICES[service]["security_opt"]
