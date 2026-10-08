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
APP = ("server", "worker", "worker-gpu", "migrate", "mdns", "caddy")
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
        ("worker", "eclume-server", "eclume-server", "ECLUME_MINIO_SERVER_PASSWORD"),
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
PYTHON = ("server", "worker", "worker-gpu", "migrate", "mdns")


def _networks(service: str) -> set[str]:
    return set(SERVICES[service].get("networks") or [])


def test_rede_worker_gpu_longe_do_postgres_do_server_e_da_borda() -> None:
    gpu = _networks("worker-gpu")
    assert gpu == {"fila-gpu", "saida"}
    for other in ("postgres", "server", "caddy"):
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


# Serviços de longa duração com teto; o mdns (rede do host, só anúncio) e o Postgres (protegido
# pelo `oom_score_adj`) ficam de fora.
LIMITS = {"caddy": "256m", "server": "768m", "worker": "2g", "worker-gpu": "8g", "redis": "256m", "minio": "512m"}
_UNIT = {"m": 1, "g": 1024}


def _mb(valor: str) -> int:
    return int(valor[:-1]) * _UNIT[valor[-1]]


def _padrao(texto: str, var: str) -> str:
    """O padrão de `${VAR:-padrão}` (ou do último fallback aninhado)."""
    match = re.fullmatch(rf"\$\{{{var}:-(?:\$\{{\w+:-)?(\d+[mg])\}}+", texto)
    assert match, texto
    return match.group(1)


@pytest.mark.parametrize(("service", "teto"), LIMITS.items())
def test_limite_de_memoria_por_env(service: str, teto: str) -> None:
    var = "ECLUME_MEM_" + service.upper().replace("-", "_")
    assert _padrao(str(SERVICES[service]["mem_limit"]), var) == teto


@pytest.mark.parametrize("service", LIMITS)
def test_limite_memswap_e_uma_vez_e_meia_o_teto(service: str) -> None:
    """Sem `memswap_limit`, o contêiner usaria outro tanto em swap."""
    var = "ECLUME_MEMSWAP_" + service.upper().replace("-", "_")
    memswap = _padrao(str(SERVICES[service]["memswap_limit"]), var)
    assert _mb(memswap) * 2 == _mb(LIMITS[service]) * 3


def test_limite_so_onde_ha_teto() -> None:
    """Teto em todo serviço de longa duração, menos o Postgres e o mdns."""
    longos = {name for name, service in SERVICES.items() if not service.get("profiles")}
    assert {name for name in longos if "mem_limit" in SERVICES[name]} == set(LIMITS)
    assert longos - set(LIMITS) == {"postgres", "mdns"}


def test_limite_worker_aceita_o_nome_anterior() -> None:
    """O env.prod com ECLUME_MEM_WORKER_AGENTS (antes do worker único) continua valendo."""
    assert SERVICES["worker"]["mem_limit"] == "${ECLUME_MEM_WORKER:-${ECLUME_MEM_WORKER_AGENTS:-2g}}"


@pytest.mark.parametrize(
    ("service", "peso"),
    [
        ("caddy", 2048),
        ("server", 2048),
        ("postgres", 2048),
        ("redis", 1024),
        ("minio", 1024),
        ("worker", 1024),
        ("worker-gpu", 512),
        ("mdns", 512),
    ],
)
def test_limite_peso_de_cpu_por_papel(service: str, peso: int) -> None:
    assert SERVICES[service]["cpu_shares"] == peso


def test_limite_postgres_protegido_do_oom() -> None:
    assert SERVICES["postgres"]["oom_score_adj"] < 0
    assert SERVICES["postgres"]["shm_size"] == "256m"


def test_limite_build_do_desktop() -> None:
    script = Path(__file__).with_name("release-desktop.sh").read_text(encoding="utf-8")
    runs = re.findall(r"--cpus 2[^\n]*", script)
    assert runs
    assert all('--memory "$MEMORIA"' in run for run in runs)


def test_healthcheck_do_server_e_a_prontidao() -> None:
    """O server fica unhealthy com Postgres, Redis ou MinIO fora."""
    test = " ".join(SERVICES["server"]["healthcheck"]["test"])
    assert "/api/v1/health/ready" in test


def test_worker_unico_com_as_duas_filas() -> None:
    """Um worker CPU só, pelo `eclume-server worker`, sem os dois serviços de antes."""
    worker = SERVICES["worker"]
    assert worker["command"] == ["eclume-server", "worker"]
    assert set(worker["networks"]) == {"dados", "saida"}
    env = _env("worker")
    assert env["ECLUME_AGENT_MAX_JOBS"] == "${ECLUME_AGENT_MAX_JOBS:-2}"
    assert "ECLUME_CLAUDE_OAUTH_TOKEN" in env["CLAUDE_CODE_OAUTH_TOKEN"]
    assert not {"worker-cpu", "worker-agents"} & set(SERVICES)


def test_healthcheck_do_worker_pela_sonda_leve_das_duas_filas() -> None:
    """O worker único é sondado pela chave de health-check das duas filas, sem o CLI inteiro."""
    assert SERVICES["worker"]["healthcheck"]["test"] == [
        "CMD",
        "python",
        "-m",
        "eclume_server.sonda",
        "fila",
        "default",
        "agents",
    ]


_SEGUNDOS = {"s": 1, "m": 60}


def _s(valor: str) -> int:
    return int(valor[:-1]) * _SEGUNDOS[valor[-1]]


@pytest.mark.parametrize(
    ("service", "intervalo"),
    [("server", 30), ("worker", 60), ("worker-gpu", 60), ("postgres", 30), ("redis", 30), ("minio", 30)],
)
def test_healthcheck_espacado_com_inicio_curto(service: str, intervalo: int) -> None:
    """Intervalo longo; `start_interval` curto dentro de um `start_period` para o `up --wait`."""
    check = SERVICES[service]["healthcheck"]
    assert _s(check["interval"]) == intervalo
    assert _s(check["start_interval"]) <= 2  # noqa: PLR2004
    assert _s(check["start_period"]) >= 30  # noqa: PLR2004


def test_healthcheck_do_worker_gpu_pelo_heartbeat_com_folga_para_o_modelo() -> None:
    """O worker GPU é sondado pelo heartbeat, com folga para a carga do modelo."""
    check = SERVICES["worker-gpu"]["healthcheck"]
    assert check["test"] == ["CMD", "python", "-m", "eclume_worker.health", "--sonda"]
    assert check["start_period"] == "120s"


def test_healthcheck_em_todo_servico_da_aplicacao_que_fica_no_ar() -> None:
    """Server e workers têm healthcheck."""
    for name in ("server", "worker", "worker-gpu"):
        assert "healthcheck" in SERVICES[name], name


def test_ca_caddy_monta_so_a_pasta_da_raiz_e_so_leitura() -> None:
    volumes = SERVICES["caddy"]["volumes"]
    assert "${ECLUME_DATA_DIR}/secrets/ca:/etc/caddy/ca:ro" in volumes
    assert not [v for v in volumes if re.search(r"/secrets(/?:|/(?!ca:))", v)]


def test_ca_caddyfile_define_a_raiz_propria_e_emite_pela_ativa() -> None:
    caddyfile = CONFIGS["caddyfile"]["content"]
    assert re.search(
        r"pki \{\s*ca eclume \{.*?root \{\s*cert /etc/caddy/ca/raiz\.crt\s*key /etc/caddy/ca/raiz\.key",
        caddyfile,
        re.DOTALL,
    )
    assert re.search(r"issuer internal \{\s*ca \$\{ECLUME_TLS_CA:-local\}\s*\}", caddyfile)
    assert "tls internal" not in caddyfile


def test_ca_publish_publica_a_ativa_e_a_proxima() -> None:
    publish = SERVICES["publish-ca"]
    assert "${ECLUME_DATA_DIR}/secrets/ca:/ca:ro" in publish["volumes"]
    script = publish["entrypoint"][-1]
    ativa_eclume, ativa_local = script.split("else", 1)
    assert '"${ECLUME_TLS_CA:-local}" = eclume' in ativa_eclume
    assert "/ca/raiz.crt /downloads/eclume-root.crt" in ativa_eclume
    assert "rm -f /downloads/eclume-root-proxima.crt" in ativa_eclume
    assert "authorities/local/root.crt /downloads/eclume-root.crt" in ativa_local
    assert "/ca/raiz.crt /downloads/eclume-root-proxima.crt" in ativa_local


@pytest.mark.parametrize("service", ["server", "mdns"])
def test_ca_proxima_no_descritor_e_no_anuncio(service: str) -> None:
    env = _env(service)
    assert env["ECLUME_CA_FILE"] == "/srv/downloads/eclume-root.crt"
    assert env["ECLUME_CA_NEXT_FILE"] == "/srv/downloads/eclume-root-proxima.crt"


def test_ca_instalacao_nova_ja_nasce_restrita() -> None:
    assert re.search(r"^ECLUME_TLS_CA=eclume$", ENV_EXAMPLE, re.MULTILINE)
    assert re.search(r"^ECLUME_CA_NOMES=", ENV_EXAMPLE, re.MULTILINE)


WEB_CADDYFILE = Path(__file__).with_name("web.Caddyfile").read_text(encoding="utf-8")
WEB_DOCKERFILE = Path(__file__).with_name("web.Dockerfile").read_text(encoding="utf-8")
CSP_SPA = (
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; "
    "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; "
    "object-src 'none'"
)
CSP_REFERENCIA = (
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; "
    "script-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
)


def test_borda_sem_o_servico_web() -> None:
    """O SPA mora na imagem da borda: não há serviço `web` nem proxy para ele."""
    assert "web" not in SERVICES
    assert "web:80" not in CONFIGS["caddyfile"]["content"]
    assert "web" not in (SERVICES["caddy"].get("depends_on") or {})


def test_borda_e_a_imagem_edge_com_tag_do_sha_e_rotulo() -> None:
    """`eclume-edge:prod` sai do web.Dockerfile, com a tag do SHA e o rótulo `edge` da retenção."""
    caddy = SERVICES["caddy"]
    assert caddy["image"] == "eclume-edge:prod"
    assert caddy["build"]["dockerfile"] == "deploy/web.Dockerfile"
    assert caddy["build"]["tags"] == ["eclume-edge:${ECLUME_COMMIT:-sem-commit}"]
    assert caddy["build"]["labels"]["org.eclume.image"] == "edge"


def test_borda_inclui_o_spa_depois_das_rotas_do_server() -> None:
    """/api, /media, /mcp e /downloads vêm antes do `import` das regras do SPA, no fim do site."""
    caddyfile = CONFIGS["caddyfile"]["content"]
    spa = caddyfile.index("import /etc/caddy/spa.caddy")
    for rota in ("handle /api/*", "handle /media/*", "handle /mcp", "handle_path /downloads/*"):
        assert caddyfile.index(rota) < spa, rota
    assert [linha.strip() for linha in caddyfile[spa:].strip().splitlines()] == ["import /etc/caddy/spa.caddy", "}"]


def test_borda_imagem_leva_o_spa_e_as_regras() -> None:
    """O Dockerfile copia o dist para /srv/web e as regras para o caminho do `import`."""
    assert "COPY deploy/web.Caddyfile /etc/caddy/spa.caddy" in WEB_DOCKERFILE
    assert "COPY --from=build /app/web/dist /srv/web" in WEB_DOCKERFILE
    assert "import /etc/caddy/spa.caddy" in WEB_DOCKERFILE
    assert "root * /srv/web" in WEB_CADDYFILE


def test_borda_csp_e_cache_do_spa() -> None:
    """As CSPs, o cache dos assets só para o arquivo que existe, o index no-cache e o erro no-store."""
    assert f'Content-Security-Policy "{CSP_SPA}"' in WEB_CADDYFILE
    assert f'Content-Security-Policy "{CSP_REFERENCIA}"' in WEB_CADDYFILE
    assert re.search(
        r'handle /assets/\* \{\s*@exists file\s*header @exists Cache-Control "public, max-age=31536000, immutable"',
        WEB_CADDYFILE,
    )
    assert re.search(r'handle \{\s*header Cache-Control "no-cache"\s*try_files \{path\} /index.html', WEB_CADDYFILE)
    assert re.search(r'handle_errors \{\s*header Cache-Control "no-store"', WEB_CADDYFILE)


# Premissa do IP do cliente (`ratelimit.client_ip`): o server confia no `X-Forwarded-For` que chega.
_RISCO_IP = (
    "O server roda com `--forwarded-allow-ips *` e `ratelimit.client_ip` usa o `X-Forwarded-For` que chega. "
    "Isso só é seguro porque o Caddy sobrescreve o cabeçalho (sem `trusted_proxies`) e porque só o Caddy "
    "publica porta. Quebrar isso deixa qualquer um forjar o IP por requisição e zera os limites por IP de "
    "login, pareamento e cadastro. Se a mudança é intencional, revise o modelo de confiança e este teste juntos."
)
SERVER_DOCKERFILE = Path(__file__).with_name("server.Dockerfile").read_text(encoding="utf-8")


def test_premissa_ip_so_o_caddy_publica_porta() -> None:
    publicam = {name for name, service in SERVICES.items() if service.get("ports")}
    assert publicam == {"caddy"}, f"serviços com `ports:` além do caddy: {publicam - {'caddy'}}. {_RISCO_IP}"


def test_premissa_ip_caddy_nao_confia_em_proxy_a_frente() -> None:
    caddyfile = CONFIGS["caddyfile"]["content"]
    assert "trusted_proxies" not in caddyfile, _RISCO_IP
    assert "trusted_proxies" not in WEB_CADDYFILE, _RISCO_IP


def test_premissa_ip_forwarded_allow_ips_do_server_nao_muda() -> None:
    cmd = re.search(r"^CMD (\[.*\])$", SERVER_DOCKERFILE, re.MULTILINE)
    assert cmd, "CMD do server.Dockerfile não encontrado"
    args = re.findall(r'"([^"]*)"', cmd.group(1))
    assert "--proxy-headers" in args, _RISCO_IP
    assert args[args.index("--forwarded-allow-ips") + 1] == "*", _RISCO_IP
    assert "command" not in SERVICES["server"], f"o server não pode sobrescrever o CMD. {_RISCO_IP}"
