# ruff: noqa: INP001, S101  # testes soltos dos scripts de deploy; deploy/ não é pacote Python
"""Testes do `fixacoes.py`: cada recusa provada por fixture e o repositório sem regressão."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import yaml

_spec = importlib.util.spec_from_file_location("fixacoes", Path(__file__).with_name("fixacoes.py"))
assert _spec is not None
assert _spec.loader is not None
fixacoes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fixacoes)

RAIZ = Path(__file__).resolve().parent.parent
SHA = "0123456789abcdef0123456789abcdef01234567"
DIGEST = "@sha256:" + "a" * 64


def problemas_do_repo(prefixo: str) -> list[str]:
    """Os problemas do repositório cujo texto começa por um dos prefixos (separados por `|`)."""
    return [p for p in fixacoes.verificar(RAIZ) if p.startswith(tuple(prefixo.split("|")))]


# --- fixtures: cada recusa ------------------------------------------------------------------------


def test_fixture_workflow_recusa_tag_movel_e_aceita_sha_com_comentario() -> None:
    """Action por tag, ou por SHA sem a versão no comentário, é recusada; `./` é local."""
    texto = f"""
      - uses: actions/checkout@v7
      - uses: actions/setup-node@{SHA}
      - uses: actions/setup-uv@{SHA} # v8.0.0
      - uses: ./.github/actions/local
"""
    problemas = fixacoes.problemas_workflow(texto, "ci.yml")
    assert [p.split(": ", 1)[1] for p in problemas] == [
        "action actions/checkout@v7 sem SHA de commit",
        f"action actions/setup-node@{SHA} sem o comentário da versão",
    ]


def test_fixture_workflow_recusa_runner_latest_tambem_na_matriz() -> None:
    """`runs-on: ubuntu-latest` e `os: windows-latest` na matriz são recusados; comentário não."""
    texto = """
    runs-on: ubuntu-latest
    # migra de windows-latest para windows-2025
    alvos = [{"os": "windows-latest"}]
    runs-on: ubuntu-24.04
"""
    problemas = fixacoes.problemas_workflow(texto, "x.yml")
    assert [p.split(": ", 1)[1] for p in problemas] == [
        "runs-on ubuntu-latest (nomeie a imagem)",
        "runner windows-latest (nomeie a imagem)",
    ]


def test_fixture_dockerfile_recusa_imagem_externa_sem_digest() -> None:
    """`FROM` e `COPY --from=` externos precisam de digest; estágio e `eclume-*` não."""
    texto = f"""FROM node:22-bookworm-slim AS build
FROM python:3.12-slim{DIGEST} AS final
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
COPY --from=ghcr.io/astral-sh/uv:0.11{DIGEST} /uvx /usr/local/bin/uvx
COPY --from=build /app /app
FROM eclume-desktop-build:24.04
FROM build
"""
    problemas = fixacoes.problemas_dockerfile(texto, "x.Dockerfile")
    assert problemas == [
        "x.Dockerfile:1: FROM node:22-bookworm-slim sem @sha256:",
        "x.Dockerfile:3: COPY --from=ghcr.io/astral-sh/uv:0.11 sem @sha256:",
    ]


def test_fixture_imagem_de_compose_sem_digest() -> None:
    """`image:` externo sem digest é recusado; as imagens do eclume não."""
    texto = f"""
    image: redis:7-alpine
    image: "pgvector/pgvector:pg16{DIGEST}"
    image: eclume-server:prod
"""
    assert fixacoes.problemas_compose(texto, "c.yml") == ["c.yml:2: image redis:7-alpine sem @sha256:"]


def test_fixture_npx_yes_recusado() -> None:
    """`npx --yes` e `npx -y` baixam o que a rede servir; `--no-install` lê o lockfile."""
    texto = "npx --yes @tauri-apps/cli@2 build\nnpx -y playwright@1 install\nnpx --no-install tauri build\n"
    assert [p.split(":")[1] for p in fixacoes.problemas_npx(texto, "s.sh")] == ["1", "2"]


def test_fixture_rust_exato_e_igual_nos_dois_pilares() -> None:
    """Sem arquivo, com `stable` ou com versões diferentes, o Rust é recusado."""
    toml = '[toolchain]\nchannel = "{}"\n'
    assert fixacoes.problemas_rust(toml.format("1.90.0"), toml.format("1.90.0")) == []
    assert "ausente" in fixacoes.problemas_rust(None, toml.format("1.90.0"))[0]
    assert "não é versão exata" in fixacoes.problemas_rust(toml.format("stable"), toml.format("1.90.0"))[0]
    assert "Rust diferente" in fixacoes.problemas_rust(toml.format("1.90.0"), toml.format("1.91.0"))[0]


def test_fixture_tauri_cli_exata_e_igual() -> None:
    """A CLI do Tauri com faixa, ausente ou divergente entre desktop e mobile é recusada."""
    exata = {"devDependencies": {"@tauri-apps/cli": "2.12.0"}}
    assert fixacoes.problemas_tauri(exata, exata) == []
    assert (
        "não é versão exata" in fixacoes.problemas_tauri(exata, {"devDependencies": {"@tauri-apps/cli": "^2.9.0"}})[0]
    )
    assert "sem @tauri-apps/cli" in fixacoes.problemas_tauri({}, exata)[0]
    assert "diferente" in fixacoes.problemas_tauri(exata, {"dependencies": {"@tauri-apps/cli": "2.11.0"}})[0]


def test_fixture_node_do_nvmrc_nos_engines() -> None:
    """Sem `.nvmrc`, ou com `engines.node` divergente, o Node é recusado."""
    assert fixacoes.problemas_node(None, {}) == [".nvmrc ausente ou sem o major do Node"]
    problemas = fixacoes.problemas_node("22\n", {"web": {"engines": {"node": "22"}}, "mobile": {}})
    assert problemas == ["mobile/package.json: engines.node None, esperado '22' do .nvmrc"]


def test_fixture_dependabot_cobre_cada_manifesto() -> None:
    """Par (ecossistema, diretório) sem entrada no `dependabot.yml` é recusado."""
    texto = """
updates:
  - package-ecosystem: npm
    directories:
      - "/web"
      - "/mobile"
  - package-ecosystem: uv
    directory: "/"
"""
    esperados = {("npm", "web"), ("npm", "mobile"), ("uv", ""), ("cargo", "desktop")}
    assert fixacoes.problemas_dependabot(texto, esperados) == ["dependabot sem cargo em /desktop"]
    assert fixacoes.problemas_dependabot(None, esperados) == [".github/dependabot.yml ausente"]


# --- o repositório --------------------------------------------------------------------------------


def test_repo_rust() -> None:
    """Rust fixado e igual em desktop e mobile."""
    assert problemas_do_repo("desktop/rust-toolchain|mobile/rust-toolchain|Rust") == []


def test_repo_node() -> None:
    """`.nvmrc` e `engines.node` em todo projeto npm."""
    assert problemas_do_repo(".nvmrc|web/package.json|mobile/package.json: engines|desktop/ui-tests") == []


def test_repo_tauri() -> None:
    """A CLI do Tauri exata e igual no desktop e no mobile."""
    assert [p for p in fixacoes.verificar(RAIZ) if "@tauri-apps/cli" in p] == []


def test_repo_dockerfile() -> None:
    """Toda imagem base externa dos Dockerfiles do desktop por digest, sem `npx --yes`."""
    assert problemas_do_repo("desktop/build") == []


def test_repo_workflow() -> None:
    """Toda action por SHA, nenhum runner `*-latest`, nenhum `npx --yes` nos workflows."""
    assert [
        p for p in fixacoes.verificar(RAIZ) if p.split(":", 1)[0].endswith(".yml") and "/" not in p.split(":", 1)[0]
    ] == []


def test_repo_imagem() -> None:
    """Toda imagem externa dos Dockerfiles e composes de `deploy/` e do worker por digest."""
    assert [p for p in problemas_do_repo("deploy/|worker-gpu/") if "@sha256:" in p] == []


def test_repo_dependabot() -> None:
    """Todo diretório com manifesto coberto pelo Dependabot."""
    assert problemas_do_repo(".github/dependabot|dependabot") == []


def test_repo_sem_problema_nenhum() -> None:
    """O conjunto: nenhuma fixação regrediu."""
    assert fixacoes.verificar(RAIZ) == []


def test_repo_dependabot_semanal_agrupado_com_espera() -> None:
    """Cada entrada do Dependabot é semanal, agrupada e espera 7 dias depois da publicação."""
    config = yaml.safe_load((RAIZ / ".github/dependabot.yml").read_text(encoding="utf-8"))
    for entrada in config["updates"]:
        assert entrada["schedule"]["interval"] == "weekly", entrada
        assert entrada["cooldown"]["default-days"] == 7, entrada  # noqa: PLR2004
        assert entrada["groups"], entrada
