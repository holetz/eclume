# ruff: noqa: INP001  # script solto, chamado pelo teste e à mão; deploy/ não é pacote Python
"""Confere as fixações de toolchain, actions e imagens do eclume, só com a stdlib.

Acusa:

- `uses:` de workflow sem SHA de commit (40 hex) e sem o comentário da versão;
- `runs-on` com `*-latest`;
- `FROM`, `COPY --from=` e `image:` de imagem externa sem `@sha256:` (as imagens `eclume-*` são
  construídas aqui e os estágios do próprio Dockerfile não contam);
- `npx --yes` (ou `-y`) em script, workflow ou Dockerfile;
- Rust ausente, sem versão exata ou diferente entre `desktop/` e `mobile/rust-toolchain.toml`;
- `@tauri-apps/cli` com faixa, ausente ou diferente entre `desktop/` e `mobile/package.json`;
- `.nvmrc` ausente ou `engines.node` divergente dele nos `package.json` dos projetos npm;
- diretório com manifesto sem cobertura no `.github/dependabot.yml`.

Uso: python3 deploy/fixacoes.py [--raiz .]   (sai 1 e lista os problemas, se houver)
Contrato: docs/standards/code/monorepo.md.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

SHA = re.compile(r"^[0-9a-f]{40}$")
RUST_EXATO = re.compile(r"^\d+\.\d+\.\d+$")
SEMVER_EXATO = re.compile(r"^\d+\.\d+\.\d+$")
USES = re.compile(r"^\s*-?\s*uses:\s*(?P<ref>\S+)\s*(?:#\s*(?P<comentario>\S.*))?$")
RUNS_ON = re.compile(r"^\s*runs-on:\s*(?P<valor>\S+)")
NPX_YES = re.compile(r"\bnpx\s+(?:[^\n]*\s)?(?:--yes|-y)\b")
FROM = re.compile(r"^\s*FROM\s+(?:--platform=\S+\s+)?(?P<imagem>\S+)(?:\s+AS\s+(?P<estagio>\S+))?", re.IGNORECASE)
COPY_FROM = re.compile(r"--from=(?P<imagem>\S+)")
IMAGE = re.compile(r"^\s*image:\s*(?P<imagem>\S+)")

# Projetos npm e cargo do repositório, com o ecossistema do Dependabot que os cobre.
PROJETOS_NPM = ("web", "mobile", "desktop", "desktop/ui-tests")
PROJETOS_NODE = ("web", "mobile", "desktop/ui-tests")
PROJETOS_CARGO = ("desktop", "mobile")


def imagem_local(imagem: str) -> bool:
    """Imagens construídas pelo próprio repositório (`eclume-*`) não vêm de registry."""
    return imagem.rsplit("/", 1)[-1].startswith("eclume-")


def imagem_fixada(imagem: str) -> bool:
    """`nome:tag@sha256:<64 hex>` (ou só `nome@sha256:`)."""
    return re.search(r"@sha256:[0-9a-f]{64}$", imagem) is not None


def problemas_workflow(texto: str, nome: str) -> list[str]:
    """Actions sem SHA ou sem comentário de versão, e runners `*-latest`."""
    problemas = []
    for n, linha in enumerate(texto.splitlines(), 1):
        if m := USES.match(linha):
            ref = m["ref"].strip("'\"")
            if ref.startswith("./"):
                continue
            _, _, versao = ref.partition("@")
            if not SHA.match(versao):
                problemas.append(f"{nome}:{n}: action {ref} sem SHA de commit")
            elif not m["comentario"]:
                problemas.append(f"{nome}:{n}: action {ref} sem o comentário da versão")
        if (m := RUNS_ON.match(linha)) and m["valor"].endswith("-latest"):
            problemas.append(f"{nome}:{n}: runs-on {m['valor']} (nomeie a imagem)")
        # O runner também chega por matriz (`os: windows-latest`); comentário não conta.
        runner = re.search(r"\b(?:ubuntu|windows|macos)-latest\b", linha)
        if runner and not RUNS_ON.match(linha) and not linha.lstrip().startswith("#"):
            problemas.append(f"{nome}:{n}: runner {runner[0]} (nomeie a imagem)")
    return problemas


VARIAVEL = re.compile(r"\$\{[^}]+\}|\$\w+")


def estagio_escolhido(imagem: str, estagios: set[str]) -> bool:
    """`FROM estagio-${ARG}`: com variável, a referência é um estágio se casa algum deles."""
    if "$" not in imagem:
        return imagem in estagios
    padrao = ".+".join(re.escape(parte) for parte in VARIAVEL.split(imagem))
    return any(re.fullmatch(padrao, estagio) for estagio in estagios)


def problemas_dockerfile(texto: str, nome: str) -> list[str]:
    """`FROM` e `COPY --from=` externos sem digest."""
    problemas = []
    estagios: set[str] = set()
    for n, linha in enumerate(texto.splitlines(), 1):
        if m := FROM.match(linha):
            imagem = m["imagem"]
            if not estagio_escolhido(imagem, estagios) and not imagem_local(imagem) and not imagem_fixada(imagem):
                problemas.append(f"{nome}:{n}: FROM {imagem} sem @sha256:")
            if m["estagio"]:
                estagios.add(m["estagio"])
        if linha.lstrip().upper().startswith("COPY") and (m := COPY_FROM.search(linha)):
            imagem = m["imagem"]
            if imagem not in estagios and not imagem.isdigit() and not imagem_fixada(imagem):
                problemas.append(f"{nome}:{n}: COPY --from={imagem} sem @sha256:")
    return problemas


def problemas_compose(texto: str, nome: str) -> list[str]:
    """`image:` externo sem digest."""
    problemas = []
    for n, linha in enumerate(texto.splitlines(), 1):
        if m := IMAGE.match(linha):
            imagem = m["imagem"].strip("'\"")
            if not imagem_local(imagem) and not imagem_fixada(imagem):
                problemas.append(f"{nome}:{n}: image {imagem} sem @sha256:")
    return problemas


def problemas_npx(texto: str, nome: str) -> list[str]:
    """`npx --yes` baixa e roda o que a rede servir naquele dia."""
    return [
        f"{nome}:{n}: npx --yes (use o lockfile e npx --no-install)"
        for n, linha in enumerate(texto.splitlines(), 1)
        if NPX_YES.search(linha)
    ]


def versao_rust(texto: str | None) -> str | None:
    """`toolchain.channel` de um `rust-toolchain.toml`, ou None."""
    if texto is None:
        return None
    return tomllib.loads(texto).get("toolchain", {}).get("channel")


def problemas_rust(desktop: str | None, mobile: str | None) -> list[str]:
    """Os dois `rust-toolchain.toml` existem, com a mesma versão exata."""
    problemas = []
    versoes = {"desktop": versao_rust(desktop), "mobile": versao_rust(mobile)}
    for pilar, versao in versoes.items():
        if versao is None:
            problemas.append(f"{pilar}/rust-toolchain.toml ausente ou sem toolchain.channel")
        elif not RUST_EXATO.match(versao):
            problemas.append(f"{pilar}/rust-toolchain.toml: channel {versao} não é versão exata")
    if None not in versoes.values() and versoes["desktop"] != versoes["mobile"]:
        problemas.append(f"Rust diferente: desktop {versoes['desktop']}, mobile {versoes['mobile']}")
    return problemas


def versao_tauri_cli(pacote: dict | None) -> str | None:
    """A versão declarada de `@tauri-apps/cli` num `package.json`, ou None."""
    if pacote is None:
        return None
    for secao in ("devDependencies", "dependencies"):
        if versao := (pacote.get(secao) or {}).get("@tauri-apps/cli"):
            return versao
    return None


def problemas_tauri(desktop: dict | None, mobile: dict | None) -> list[str]:
    """A CLI do Tauri é exata e a mesma no desktop e no mobile."""
    problemas = []
    versoes = {"desktop": versao_tauri_cli(desktop), "mobile": versao_tauri_cli(mobile)}
    for pilar, versao in versoes.items():
        if versao is None:
            problemas.append(f"{pilar}/package.json sem @tauri-apps/cli")
        elif not SEMVER_EXATO.match(versao):
            problemas.append(f"{pilar}/package.json: @tauri-apps/cli {versao} não é versão exata")
    if None not in versoes.values() and versoes["desktop"] != versoes["mobile"]:
        problemas.append(f"@tauri-apps/cli diferente: desktop {versoes['desktop']}, mobile {versoes['mobile']}")
    return problemas


def problemas_node(nvmrc: str | None, pacotes: dict[str, dict]) -> list[str]:
    """`.nvmrc` com o major e `engines.node` igual a ele em cada projeto."""
    if nvmrc is None or not nvmrc.strip().isdigit():
        return [".nvmrc ausente ou sem o major do Node"]
    major = nvmrc.strip()
    problemas = []
    for projeto, pacote in pacotes.items():
        engine = (pacote.get("engines") or {}).get("node")
        if engine != major:
            problemas.append(f"{projeto}/package.json: engines.node {engine!r}, esperado {major!r} do .nvmrc")
    return problemas


def coberturas_dependabot(texto: str) -> set[tuple[str, str]]:
    """(ecossistema, diretório sem barras) de cada `updates` do `dependabot.yml`."""
    cobertos = set()
    ecossistema = None
    for linha in texto.splitlines():
        if m := re.match(r"^\s*-\s*package-ecosystem:\s*['\"]?([\w-]+)", linha):
            ecossistema = m[1]
        elif (m := re.match(r"^\s*directory:\s*['\"]?([^'\"\s]+)", linha)) and ecossistema:
            cobertos.add((ecossistema, m[1].strip("/")))
        elif (m := re.match(r"^\s*-\s*['\"]?(/[^'\"\s]*)['\"]?\s*$", linha)) and ecossistema:
            cobertos.add((ecossistema, m[1].strip("/")))  # item de `directories:`
    return cobertos


def problemas_dependabot(texto: str | None, esperados: set[tuple[str, str]]) -> list[str]:
    """Todo par (ecossistema, diretório) esperado aparece no `dependabot.yml`."""
    if texto is None:
        return [".github/dependabot.yml ausente"]
    cobertos = coberturas_dependabot(texto)
    return [f"dependabot sem {eco} em /{pasta}" for eco, pasta in sorted(esperados - cobertos)]


def esperados_dependabot(raiz: Path) -> set[tuple[str, str]]:
    """Os pares (ecossistema, diretório) que os manifestos do repositório pedem."""
    esperados = {("uv", ""), ("github-actions", ""), ("docker-compose", "deploy"), ("docker", "deploy")}
    esperados |= {("npm", p) for p in PROJETOS_NPM if (raiz / p / "package.json").exists()}
    esperados |= {("cargo", p) for p in PROJETOS_CARGO if (raiz / p / "Cargo.toml").exists()}
    esperados |= {("rust-toolchain", p) for p in PROJETOS_CARGO}
    esperados |= {("docker", str(d.parent.relative_to(raiz)).replace("\\", "/")) for d in raiz.glob("*/*Dockerfile")}
    if (raiz / "mobile/src-tauri/gen/android/build.gradle.kts").exists():
        esperados.add(("gradle", "mobile/src-tauri/gen/android"))
    return esperados


def _ler(caminho: Path) -> str | None:
    return caminho.read_text(encoding="utf-8") if caminho.exists() else None


def _json(caminho: Path) -> dict | None:
    texto = _ler(caminho)
    return json.loads(texto) if texto is not None else None


def verificar(raiz: Path) -> list[str]:
    """Todos os problemas de fixação do repositório em `raiz`."""
    problemas: list[str] = []
    for wf in sorted((raiz / ".github/workflows").glob("*.yml")):
        texto = wf.read_text(encoding="utf-8")
        problemas += problemas_workflow(texto, wf.name) + problemas_npx(texto, wf.name)
    for df in sorted({*raiz.glob("*/*Dockerfile"), *raiz.glob("*/*.Dockerfile")}):
        texto = df.read_text(encoding="utf-8")
        rel = df.relative_to(raiz).as_posix()
        problemas += problemas_dockerfile(texto, rel) + problemas_npx(texto, rel)
    for compose in sorted(raiz.glob("deploy/docker-compose*.yml")):
        problemas += problemas_compose(compose.read_text(encoding="utf-8"), compose.relative_to(raiz).as_posix())
    for script in sorted({*raiz.glob("deploy/*.sh"), *raiz.glob("*/scripts/*.sh")}):
        problemas += problemas_npx(script.read_text(encoding="utf-8"), script.relative_to(raiz).as_posix())
    problemas += problemas_rust(_ler(raiz / "desktop/rust-toolchain.toml"), _ler(raiz / "mobile/rust-toolchain.toml"))
    problemas += problemas_tauri(_json(raiz / "desktop/package.json"), _json(raiz / "mobile/package.json"))
    pacotes = {p: _json(raiz / p / "package.json") or {} for p in PROJETOS_NODE}
    problemas += problemas_node(_ler(raiz / ".nvmrc"), pacotes)
    problemas += problemas_dependabot(_ler(raiz / ".github/dependabot.yml"), esperados_dependabot(raiz))
    return problemas


def main(argv: list[str] | None = None) -> int:
    """Ponto de entrada da linha de comando."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--raiz", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args(argv)
    problemas = verificar(args.raiz)
    sys.stdout.writelines(f"{p}\n" for p in problemas)
    return 1 if problemas else 0


if __name__ == "__main__":
    sys.exit(main())
