# ruff: noqa: INP001, S101, D103  # loose tests of the production compose; deploy/ is not a Python package
"""Regression of the production compose isolation: credentials, networks and limits per service."""

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

# Application services: none sees the MinIO root credential.
APP = ("server", "worker", "worker-gpu", "migrate", "mdns", "caddy")
ROOT_USERS = ("minio", "minio-init")


def _env(service: str) -> dict[str, str]:
    return {key: str(value) for key, value in (SERVICES[service].get("environment") or {}).items()}


def _acl(user: str) -> str:
    content = CONFIGS["redis-conf"]["content"]
    match = re.search(rf"^user {re.escape(user)} (.*)$", content, re.MULTILINE)
    assert match, f"user {user} missing from the ACL"
    return match.group(1)


@pytest.mark.parametrize("service", APP)
def test_credential_minio_root_outside_the_application(service: str) -> None:
    values = " ".join(_env(service).values())
    assert "ECLUME_MINIO_USER" not in values
    assert "ECLUME_MINIO_PASSWORD}" not in values
    assert "ECLUME_MINIO_PASSWORD:" not in values


@pytest.mark.parametrize("service", ROOT_USERS)
def test_credential_root_only_in_minio_and_init(service: str) -> None:
    assert "${ECLUME_MINIO_PASSWORD}" in _env(service).values()


@pytest.mark.parametrize(
    ("service", "redis_user", "s3_user", "s3_secret"),
    [
        ("server", "eclume-server", "eclume-server", "ECLUME_MINIO_SERVER_PASSWORD"),
        ("worker", "eclume-server", "eclume-server", "ECLUME_MINIO_SERVER_PASSWORD"),
        ("worker-gpu", "eclume-gpu", "eclume-gpu", "ECLUME_MINIO_GPU_PASSWORD"),
    ],
)
def test_credential_per_service(service: str, redis_user: str, s3_user: str, s3_secret: str) -> None:
    env = _env(service)
    assert env["ECLUME_REDIS_URL"].startswith(f"redis://{redis_user}:")
    assert env["ECLUME_S3_ACCESS_KEY"] == s3_user
    assert s3_secret in env["ECLUME_S3_SECRET_KEY"]


def test_credential_redis_default_disabled() -> None:
    assert re.search(r"^user default off$", CONFIGS["redis-conf"]["content"], re.MULTILINE)
    assert "redis-conf" in {c["source"] for c in SERVICES["redis"]["configs"]}


def test_credential_redis_gpu_only_on_its_keys() -> None:
    rules = _acl("eclume-gpu").split()
    keys = {rule for rule in rules if rule.startswith(("~", "%"))}
    assert keys == {"~arq:*", "~eclume:gpu*", "~eclume:default", "~eclume:progress:*", "%R~eclume:cancel:*"}
    assert {"-@dangerous", "-@admin"} <= set(rules)


def test_credential_minio_gpu_neither_deletes_nor_lists() -> None:
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
def test_credential_new_in_the_example_env(name: str) -> None:
    assert re.search(rf"^{name}=change-me-", ENV_EXAMPLE, re.MULTILINE)


NETWORKS: dict[str, dict[str, Any]] = COMPOSE["networks"]
PYTHON = ("server", "worker", "worker-gpu", "migrate", "mdns")


def _networks(service: str) -> set[str]:
    return set(SERVICES[service].get("networks") or [])


def test_network_worker_gpu_away_from_postgres_server_and_edge() -> None:
    gpu = _networks("worker-gpu")
    assert gpu == {"fila-gpu", "saida"}
    for other in ("postgres", "server", "caddy"):
        assert not gpu & _networks(other), f"worker-gpu shares a network with {other}"


def test_network_dados_and_fila_gpu_internal() -> None:
    assert NETWORKS["dados"].get("internal") is True
    assert NETWORKS["fila-gpu"].get("internal") is True
    for service in ("postgres", "redis", "minio"):
        assert _networks(service) <= {"dados", "fila-gpu"}, f"{service} outside the internal networks"


def test_network_of_each_service_declared() -> None:
    for name, service in SERVICES.items():
        assert service.get("networks") or service.get("network_mode"), f"{name} without a declared network"
    assert SERVICES["publish-ca"]["network_mode"] == "none"
    assert SERVICES["mdns"]["network_mode"] == "host"


@pytest.mark.parametrize("service", PYTHON)
def test_network_python_container_without_capabilities(service: str) -> None:
    assert SERVICES[service]["cap_drop"] == ["ALL"]
    assert "no-new-privileges:true" in SERVICES[service]["security_opt"]


# Long-running services with a ceiling; mdns (host network, announcement only) and Postgres
# (protected by `oom_score_adj`) stay out.
LIMITS = {"caddy": "256m", "server": "768m", "worker": "2g", "worker-gpu": "8g", "redis": "256m", "minio": "512m"}
_UNIT = {"m": 1, "g": 1024}


def _mb(value: str) -> int:
    return int(value[:-1]) * _UNIT[value[-1]]


def _default(text: str, var: str) -> str:
    """The default of `${VAR:-default}` (or of the last nested fallback)."""
    match = re.fullmatch(rf"\$\{{{var}:-(?:\$\{{\w+:-)?(\d+[mg])\}}+", text)
    assert match, text
    return match.group(1)


@pytest.mark.parametrize(("service", "ceiling"), LIMITS.items())
def test_limit_memory_by_env(service: str, ceiling: str) -> None:
    var = "ECLUME_MEM_" + service.upper().replace("-", "_")
    assert _default(str(SERVICES[service]["mem_limit"]), var) == ceiling


@pytest.mark.parametrize("service", LIMITS)
def test_limit_memswap_is_one_and_a_half_the_ceiling(service: str) -> None:
    """Without `memswap_limit`, the container would use as much again in swap."""
    var = "ECLUME_MEMSWAP_" + service.upper().replace("-", "_")
    memswap = _default(str(SERVICES[service]["memswap_limit"]), var)
    assert _mb(memswap) * 2 == _mb(LIMITS[service]) * 3


def test_limit_only_where_there_is_a_ceiling() -> None:
    """A ceiling on every long-running service, except Postgres and mdns."""
    long_running = {name for name, service in SERVICES.items() if not service.get("profiles")}
    assert {name for name in long_running if "mem_limit" in SERVICES[name]} == set(LIMITS)
    assert long_running - set(LIMITS) == {"postgres", "mdns"}


def test_limit_worker_accepts_the_previous_name() -> None:
    """An env.prod with ECLUME_MEM_WORKER_AGENTS (before the single worker) still holds."""
    assert SERVICES["worker"]["mem_limit"] == "${ECLUME_MEM_WORKER:-${ECLUME_MEM_WORKER_AGENTS:-2g}}"


@pytest.mark.parametrize(
    ("service", "weight"),
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
def test_limit_cpu_weight_by_role(service: str, weight: int) -> None:
    assert SERVICES[service]["cpu_shares"] == weight


def test_limit_postgres_protected_from_the_oom() -> None:
    assert SERVICES["postgres"]["oom_score_adj"] < 0
    assert SERVICES["postgres"]["shm_size"] == "256m"


def test_limit_desktop_build() -> None:
    script = Path(__file__).with_name("release-desktop.sh").read_text(encoding="utf-8")
    runs = re.findall(r"--cpus 2[^\n]*", script)
    assert runs
    assert all('--memory "$MEMORY"' in run for run in runs)


def test_healthcheck_of_the_server_is_readiness() -> None:
    """The server turns unhealthy with Postgres, Redis or MinIO down."""
    test = " ".join(SERVICES["server"]["healthcheck"]["test"])
    assert "/api/v1/health/ready" in test


def test_single_worker_with_both_queues() -> None:
    """A single CPU worker, through `eclume-server worker`, without the two earlier services."""
    worker = SERVICES["worker"]
    assert worker["command"] == ["eclume-server", "worker"]
    assert set(worker["networks"]) == {"dados", "saida"}
    env = _env("worker")
    assert env["ECLUME_AGENT_MAX_JOBS"] == "${ECLUME_AGENT_MAX_JOBS:-2}"
    assert "ECLUME_CLAUDE_OAUTH_TOKEN" in env["CLAUDE_CODE_OAUTH_TOKEN"]
    assert not {"worker-cpu", "worker-agents"} & set(SERVICES)


def test_healthcheck_of_the_worker_by_the_light_probe_of_both_queues() -> None:
    """The single worker is probed through both queues' health-check key, without the whole CLI."""
    assert SERVICES["worker"]["healthcheck"]["test"] == [
        "CMD",
        "python",
        "-m",
        "eclume_server.sonda",
        "fila",
        "default",
        "agents",
    ]


_SECONDS = {"s": 1, "m": 60}


def _s(value: str) -> int:
    return int(value[:-1]) * _SECONDS[value[-1]]


@pytest.mark.parametrize(
    ("service", "interval"),
    [("server", 30), ("worker", 60), ("worker-gpu", 60), ("postgres", 30), ("redis", 30), ("minio", 30)],
)
def test_healthcheck_spaced_with_a_short_start(service: str, interval: int) -> None:
    """Long interval; short `start_interval` inside a `start_period` for `up --wait`."""
    check = SERVICES[service]["healthcheck"]
    assert _s(check["interval"]) == interval
    assert _s(check["start_interval"]) <= 2  # noqa: PLR2004
    assert _s(check["start_period"]) >= 30  # noqa: PLR2004


def test_healthcheck_of_the_gpu_worker_by_the_heartbeat_with_slack_for_the_model() -> None:
    """The GPU worker is probed by the heartbeat, with slack for the model load."""
    check = SERVICES["worker-gpu"]["healthcheck"]
    assert check["test"] == ["CMD", "python", "-m", "eclume_worker.health", "--sonda"]
    assert check["start_period"] == "120s"


def test_healthcheck_on_every_long_running_application_service() -> None:
    """Server and workers have a healthcheck."""
    for name in ("server", "worker", "worker-gpu"):
        assert "healthcheck" in SERVICES[name], name


def test_ca_caddy_mounts_only_the_root_folder_read_only() -> None:
    volumes = SERVICES["caddy"]["volumes"]
    assert "${ECLUME_DATA_DIR}/secrets/ca:/etc/caddy/ca:ro" in volumes
    assert not [v for v in volumes if re.search(r"/secrets(/?:|/(?!ca:))", v)]


def test_ca_caddyfile_defines_the_own_root_and_issues_through_the_active_one() -> None:
    caddyfile = CONFIGS["caddyfile"]["content"]
    assert re.search(
        r"pki \{\s*ca eclume \{.*?root \{\s*cert /etc/caddy/ca/raiz\.crt\s*key /etc/caddy/ca/raiz\.key",
        caddyfile,
        re.DOTALL,
    )
    assert re.search(r"issuer internal \{\s*ca \$\{ECLUME_TLS_CA:-local\}\s*\}", caddyfile)
    assert "tls internal" not in caddyfile


def test_ca_publish_publishes_the_active_and_the_next() -> None:
    publish = SERVICES["publish-ca"]
    assert "${ECLUME_DATA_DIR}/secrets/ca:/ca:ro" in publish["volumes"]
    script = publish["entrypoint"][-1]
    active_eclume, active_local = script.split("else", 1)
    assert '"${ECLUME_TLS_CA:-local}" = eclume' in active_eclume
    assert "/ca/raiz.crt /downloads/eclume-root.crt" in active_eclume
    assert "rm -f /downloads/eclume-root-proxima.crt" in active_eclume
    assert "authorities/local/root.crt /downloads/eclume-root.crt" in active_local
    assert "/ca/raiz.crt /downloads/eclume-root-proxima.crt" in active_local


@pytest.mark.parametrize("service", ["server", "mdns"])
def test_ca_next_in_the_descriptor_and_the_announcement(service: str) -> None:
    env = _env(service)
    assert env["ECLUME_CA_FILE"] == "/srv/downloads/eclume-root.crt"
    assert env["ECLUME_CA_NEXT_FILE"] == "/srv/downloads/eclume-root-proxima.crt"


def test_ca_new_install_is_born_constrained() -> None:
    assert re.search(r"^ECLUME_TLS_CA=eclume$", ENV_EXAMPLE, re.MULTILINE)
    assert re.search(r"^ECLUME_CA_NAMES=", ENV_EXAMPLE, re.MULTILINE)


WEB_CADDYFILE = Path(__file__).with_name("web.Caddyfile").read_text(encoding="utf-8")
WEB_DOCKERFILE = Path(__file__).with_name("web.Dockerfile").read_text(encoding="utf-8")
CSP_SPA = (
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; "
    "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; "
    "object-src 'none'"
)
CSP_API_REFERENCE = (
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; "
    "script-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
)


def test_edge_without_the_web_service() -> None:
    """The SPA lives in the edge image: there is no `web` service nor a proxy to it."""
    assert "web" not in SERVICES
    assert "web:80" not in CONFIGS["caddyfile"]["content"]
    assert "web" not in (SERVICES["caddy"].get("depends_on") or {})


def test_edge_is_the_edge_image_with_sha_tag_and_label() -> None:
    """`eclume-edge:prod` comes from web.Dockerfile, with the SHA tag and the retention label `edge`."""
    caddy = SERVICES["caddy"]
    assert caddy["image"] == "eclume-edge:prod"
    assert caddy["build"]["dockerfile"] == "deploy/web.Dockerfile"
    assert caddy["build"]["tags"] == ["eclume-edge:${ECLUME_COMMIT:-no-commit}"]
    assert caddy["build"]["labels"]["org.eclume.image"] == "edge"


def test_edge_includes_the_spa_after_the_server_routes() -> None:
    """/api, /media, /mcp and /downloads come before the `import` of the SPA rules, at the end of the site."""
    caddyfile = CONFIGS["caddyfile"]["content"]
    spa = caddyfile.index("import /etc/caddy/spa.caddy")
    for route in ("handle /api/*", "handle /media/*", "handle /mcp", "handle_path /downloads/*"):
        assert caddyfile.index(route) < spa, route
    assert [line.strip() for line in caddyfile[spa:].strip().splitlines()] == ["import /etc/caddy/spa.caddy", "}"]


def test_edge_image_carries_the_spa_and_the_rules() -> None:
    """The Dockerfile copies dist to /srv/web and the rules to the `import` path."""
    assert "COPY deploy/web.Caddyfile /etc/caddy/spa.caddy" in WEB_DOCKERFILE
    assert "COPY --from=build /app/web/dist /srv/web" in WEB_DOCKERFILE
    assert "import /etc/caddy/spa.caddy" in WEB_DOCKERFILE
    assert "root * /srv/web" in WEB_CADDYFILE


def test_edge_csp_and_cache_of_the_spa() -> None:
    """The CSPs, the asset cache only for the file that exists, the no-cache index and the no-store error."""
    assert f'Content-Security-Policy "{CSP_SPA}"' in WEB_CADDYFILE
    assert f'Content-Security-Policy "{CSP_API_REFERENCE}"' in WEB_CADDYFILE
    assert re.search(
        r'handle /assets/\* \{\s*@exists file\s*header @exists Cache-Control "public, max-age=31536000, immutable"',
        WEB_CADDYFILE,
    )
    assert re.search(r'handle \{\s*header Cache-Control "no-cache"\s*try_files \{path\} /index.html', WEB_CADDYFILE)
    assert re.search(r'handle_errors \{\s*header Cache-Control "no-store"', WEB_CADDYFILE)


# Client IP premise (`ratelimit.client_ip`): the server trusts the incoming `X-Forwarded-For`.
_IP_RISK = (
    "The server runs with `--forwarded-allow-ips *` and `ratelimit.client_ip` uses the incoming `X-Forwarded-For`. "
    "That is only safe because Caddy overwrites the header (no `trusted_proxies`) and because only Caddy "
    "publishes a port. Breaking it lets anyone forge the IP per request and zeroes the per-IP limits of "
    "login, pairing and signup. If the change is intentional, review the trust model and this test together."
)
SERVER_DOCKERFILE = Path(__file__).with_name("server.Dockerfile").read_text(encoding="utf-8")


def test_ip_premise_only_caddy_publishes_a_port() -> None:
    publishing = {name for name, service in SERVICES.items() if service.get("ports")}
    assert publishing == {"caddy"}, f"services with `ports:` besides caddy: {publishing - {'caddy'}}. {_IP_RISK}"


def test_ip_premise_caddy_does_not_trust_a_proxy_in_front() -> None:
    caddyfile = CONFIGS["caddyfile"]["content"]
    assert "trusted_proxies" not in caddyfile, _IP_RISK
    assert "trusted_proxies" not in WEB_CADDYFILE, _IP_RISK


def test_ip_premise_server_forwarded_allow_ips_does_not_change() -> None:
    cmd = re.search(r"^CMD (\[.*\])$", SERVER_DOCKERFILE, re.MULTILINE)
    assert cmd, "server.Dockerfile CMD not found"
    args = re.findall(r'"([^"]*)"', cmd.group(1))
    assert "--proxy-headers" in args, _IP_RISK
    assert args[args.index("--forwarded-allow-ips") + 1] == "*", _IP_RISK
    assert "command" not in SERVICES["server"], f"the server must not override the CMD. {_IP_RISK}"
