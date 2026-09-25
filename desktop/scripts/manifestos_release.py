# ruff: noqa: INP001  # script solto, rodado pelo workflow de release; desktop/ não é pacote Python
"""Monta os manifestos de um release do app desktop do eclume.

Lê a pasta com os artefatos que a matriz de `desktop-release.yml` produziu (instaladores, pacotes
do updater e as assinaturas `.sig`) e grava nela:

- `latest.json` — o manifesto do updater do Tauri, com as URLs absolutas sob a base pública
  (o servidor eclume, porque os assets do GitHub são privados);
- `instaladores.json` — a lista que a página de download consome;
- `SHA256SUMS` — o hash de todo arquivo da pasta, conferido na publicação no host.

As URLs ficam em `<base>/<versão>/<arquivo>`, que é onde `deploy/publicar-desktop.sh` os coloca.

Uso:
    python3 desktop/scripts/manifestos_release.py --artefatos <pasta> --versao 0.1.0 \
        --base-url https://192.168.15.199:8443/downloads [--notas "texto"]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

SUMS = "SHA256SUMS"
LATEST = "latest.json"
INSTALADORES = "instaladores.json"
MACOS_ARCHES = ("aarch64", "x86_64")


@dataclass(frozen=True)
class Tipo:
    """Um tipo de artefato reconhecido pelo sufixo do nome."""

    plataforma: str  # windows | linux | macos
    tipo: str  # nsis | msi | appimage | deb | dmg | app
    sufixo: re.Pattern[str]
    instalador: bool  # aparece na página de download
    recomendado: bool  # o instalador padrão da plataforma
    padrao_updater: bool  # atende também a chave `<os>-<arch>` sem instalador


TIPOS = (
    Tipo("windows", "nsis", re.compile(r"-setup\.exe$"), instalador=True, recomendado=True, padrao_updater=True),
    Tipo("windows", "msi", re.compile(r"\.msi$"), instalador=True, recomendado=False, padrao_updater=False),
    Tipo("linux", "appimage", re.compile(r"\.AppImage$"), instalador=True, recomendado=True, padrao_updater=True),
    Tipo("linux", "deb", re.compile(r"\.deb$"), instalador=True, recomendado=False, padrao_updater=False),
    Tipo("macos", "dmg", re.compile(r"\.dmg$"), instalador=True, recomendado=True, padrao_updater=False),
    Tipo("macos", "app", re.compile(r"\.app\.tar\.gz$"), instalador=False, recomendado=False, padrao_updater=True),
)


def arquitetura(nome: str) -> str:
    """Arquitetura pelo nome que a CLI do Tauri dá ao arquivo."""
    if "universal" in nome:
        return "universal"
    if re.search(r"aarch64|arm64", nome):
        return "aarch64"
    if re.search(r"x64|x86_64|amd64", nome):
        return "x86_64"
    msg = f"arquitetura não reconhecida em {nome}"
    raise ValueError(msg)


def updater_os(plataforma: str) -> str:
    """O updater do Tauri chama o macOS de `darwin`."""
    return "darwin" if plataforma == "macos" else plataforma


def updater_arches(arch: str) -> tuple[str, ...]:
    """Um pacote universal atende as duas arquiteturas do macOS."""
    return MACOS_ARCHES if arch == "universal" else (arch,)


def sha256(caminho: Path) -> str:
    """Hash SHA-256 do arquivo, em hexadecimal."""
    h = hashlib.sha256()
    with caminho.open("rb") as f:
        for bloco in iter(lambda: f.read(1 << 20), b""):
            h.update(bloco)
    return h.hexdigest()


def montar(pasta: Path, versao: str, base_url: str, notas: str) -> tuple[dict, dict]:
    """Devolve `(latest, instaladores)` a partir dos artefatos da pasta."""
    base = f"{base_url.rstrip('/')}/{versao}"
    agora = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    plataformas: dict[str, dict[str, str]] = {}
    instaladores: list[dict] = []
    for arquivo in sorted(p for p in pasta.iterdir() if p.is_file()):
        tipo = next((t for t in TIPOS if t.sufixo.search(arquivo.name)), None)
        if tipo is None:
            continue
        arch = arquitetura(arquivo.name)
        url = f"{base}/{arquivo.name}"
        if tipo.instalador:
            instaladores.append(
                {
                    "plataforma": tipo.plataforma,
                    "arquitetura": arch,
                    "tipo": tipo.tipo,
                    "arquivo": arquivo.name,
                    "url": url,
                    "tamanho": arquivo.stat().st_size,
                    "sha256": sha256(arquivo),
                    "recomendado": tipo.recomendado,
                }
            )
        assinatura = arquivo.with_name(arquivo.name + ".sig")
        if not assinatura.is_file():
            continue
        entrada = {"signature": assinatura.read_text().strip(), "url": url}
        for a in updater_arches(arch):
            chave = f"{updater_os(tipo.plataforma)}-{a}"
            plataformas[f"{chave}-{tipo.tipo}"] = entrada
            if tipo.padrao_updater:
                plataformas[chave] = entrada
    latest = {"version": versao, "notes": notas, "pub_date": agora, "platforms": dict(sorted(plataformas.items()))}
    lista = {
        "versao": versao,
        "publicado_em": agora,
        "notas": notas,
        "instalacao": f"{base_url.rstrip('/')}/INSTALACAO.md",
        "instaladores": instaladores,
    }
    return latest, lista


def gravar_sums(pasta: Path) -> None:
    """Grava `SHA256SUMS` no formato do `sha256sum -c`."""
    linhas = [f"{sha256(p)}  {p.name}\n" for p in sorted(pasta.iterdir()) if p.is_file() and p.name != SUMS]
    (pasta / SUMS).write_text("".join(linhas))


def main(argv: list[str] | None = None) -> int:
    """Ponto de entrada da linha de comando."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--artefatos", type=Path, required=True, help="pasta com os artefatos da matriz")
    parser.add_argument("--versao", required=True, help="versão do release, sem o prefixo desktop-v")
    parser.add_argument("--base-url", required=True, help="URL pública de /downloads")
    parser.add_argument("--notas", default="", help="notas da versão")
    args = parser.parse_args(argv)

    latest, lista = montar(args.artefatos, args.versao, args.base_url, args.notas)
    faltando = [
        c for c in ("windows-x86_64", "linux-x86_64", "darwin-aarch64", "darwin-x86_64") if c not in latest["platforms"]
    ]
    if faltando:
        sys.stderr.write(f"aviso: latest.json sem {', '.join(faltando)}\n")
    (args.artefatos / LATEST).write_text(json.dumps(latest, indent=2, ensure_ascii=False) + "\n")
    (args.artefatos / INSTALADORES).write_text(json.dumps(lista, indent=2, ensure_ascii=False) + "\n")
    gravar_sums(args.artefatos)
    sys.stdout.write(
        f"{LATEST}: {', '.join(latest['platforms'])}\n{INSTALADORES}: {len(lista['instaladores'])} instaladores\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
