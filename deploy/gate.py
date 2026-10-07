# ruff: noqa: INP001  # script solto, chamado pelos scripts de deploy e pelos workflows; deploy/ não é pacote
"""Lógica do gate de qualidade do eclume (status `eclume/gate` no commit), só com a stdlib.

Subcomandos, todos com a entrada no stdin:

- `decidir` — o status combinado do commit (`gh api repos/<repo>/commits/<sha>/status`); sai 0 só
  quando o `eclume/gate` mais recente está em `success` e, senão, diz o estado e sai 1;
- `descricao` — uma linha `<pilar> <código de saída>` por pilar executado (`--duracao <s>`,
  `--log <caminho>`, `--dispensados a,b` e `--desde <sha>` para os pilares que o diff não exigiu);
  imprime o estado final (`success`, `failure` ou `error`) e, na linha seguinte,
  a descrição do status, com no máximo 140 caracteres;
- `pilares` — os pilares que o diff `--desde <sha-verde>` até `--sha` exige (`--repo` aponta a raiz
  do git), ou que os caminhos do stdin exigem (`--stdin`, um por linha, para quem não tem o git);
  `--todos` ou diff impossível rodam todos; um pilar por linha, na ordem de `PILARES`;
- `alvos-do-push` — o stdin do hook de pre-push; imprime o SHA de cada atualização de
  `refs/heads/main`, ignorando a ref apagada.

Contrato: docs/standards/code/monorepo.md.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from typing import Any

CONTEXTO = "eclume/gate"
PILARES = (
    "python",
    "contracts",
    "web",
    "web-browser",
    "desktop",
    "mobile",
    "docs",
    "windows",
    "auditoria",
    "android",
)
# Pilares que só o gate roda: a CI não tem o xwin, a rede da auditoria nem o SDK Android (o build
# do APK verificado leva perto de 15 min) a cada PR.
SO_NO_GATE = ("windows", "auditoria", "android")
LIMITE_DESCRICAO = 140

# Caminhos que exigem cada pilar: o mesmo mapa dos filtros do `.github/workflows/ci.yml` (o
# `deploy/test_gate.py` falha se os dois divergirem) mais os três pilares que só o gate roda.
_CI = (".github/workflows/ci.yml", "deploy/pilares.sh")
_UV = ("pyproject.toml", "uv.lock", ".python-version")
_DEPENDENCIAS = (
    "pyproject.toml",
    "uv.lock",
    "web/package.json",
    "web/package-lock.json",
    "mobile/package.json",
    "mobile/package-lock.json",
    "desktop/package.json",
    "desktop/package-lock.json",
    "desktop/**/Cargo.toml",
    "desktop/Cargo.lock",
    "desktop/deny.toml",
    "mobile/**/Cargo.toml",
    "mobile/Cargo.lock",
    "mobile/deny.toml",
    "deploy/auditoria-excecoes.txt",
)
_DESKTOP = (
    *_CI,
    "desktop/**",
    "web/src/styles/eclume.css",
    "web/src/lib/vocabulario.js",
    "web/src/features/help/articles/**",
)
_MOBILE = (
    *_CI,
    "mobile/**",
    "desktop/crates/**",
    "web/src/lib/vocabulario.js",
    "web/src/lib/vocabulario.d.ts",
)
FILTROS: dict[str, tuple[str, ...]] = {
    "python": (
        *_CI,
        *_UV,
        "engines/**",
        "server/**",
        "worker-gpu/**",
        "contracts/**",
        "mobile/scripts/**",
        "design-system/**",
        "web/src/styles/eclume.css",
        "desktop/ui/eclume.css",
        "mobile/ui/src/styles/eclume.css",
        "deploy/docker-compose.test.yml",
        "deploy/gate.py",
        "deploy/test_gate.py",
        ".github/workflows/desktop-release.yml",
        "deploy/versao.py",
        "deploy/test_versao.py",
        "CHANGELOG.md",
        "desktop/CHANGELOG.md",
        "mobile/CHANGELOG.md",
        "web/package.json",
        "web/package-lock.json",
        "desktop/**/Cargo.toml",
        "desktop/Cargo.lock",
        "desktop/src-tauri/tauri.conf.json",
        "mobile/**/Cargo.toml",
        "mobile/Cargo.lock",
        "mobile/src-tauri/tauri.conf.json",
    ),
    "contracts": (*_CI, *_UV, "contracts/**", "deploy/docker-compose.mock.yml"),
    "web": (*_CI, "web/**", "contracts/**"),
    "web-browser": (*_CI, "web/**", "contracts/**", "deploy/docker-compose.mock.yml"),
    "desktop": _DESKTOP,
    "mobile": _MOBILE,
    "docs": (*_CI, "docs/**", "**/*.md", "deploy/docs_check.py", "deploy/test_docs_check.py"),
    # Só do gate: o código só-Windows é o do desktop; o APK é o do mobile; a auditoria lê as
    # dependências (e as exceções).
    "windows": _DESKTOP,
    "auditoria": (*_CI, *_DEPENDENCIAS),
    "android": _MOBILE,
}
# Mudou algum destes, o gate roda todos os pilares: o próprio gate e os scripts de deploy, o lock e
# a toolchain (uma versão nova de ferramenta pode quebrar qualquer pilar).
GATILHOS_DE_TODOS = (
    "deploy/**",
    ".github/workflows/ci.yml",
    "pyproject.toml",
    "uv.lock",
    ".python-version",
    ".nvmrc",
    "**/rust-toolchain.toml",
    "**/Cargo.lock",
    "**/package-lock.json",
)
ALVO = "refs/heads/main"
SHA_NULO = "0" * 40


def estado_do_gate(combinado: dict[str, Any]) -> str | None:
    """Estado do `eclume/gate` no status combinado (o mais recente por contexto), ou None."""
    for status in combinado.get("statuses") or []:
        if status.get("context") == CONTEXTO:
            return status.get("state")
    return None


def decidir(combinado: dict[str, Any]) -> tuple[bool, str]:
    """(liberado, mensagem) para publicar o commit do status combinado."""
    estado = estado_do_gate(combinado)
    if estado == "success":
        return True, f"{CONTEXTO} = success"
    if estado is None:
        return False, f"{CONTEXTO} ausente no commit (rode bash deploy/gate.sh)"
    return False, f"{CONTEXTO} = {estado}, não success"


def _duracao(segundos: int) -> str:
    minutos, seg = divmod(max(segundos, 0), 60)
    return f"{minutos}min{seg:02d}s" if minutos else f"{seg}s"


def _regex_do_glob(glob: str) -> re.Pattern[str]:
    """O glob dos filtros da CI (`**` atravessa pastas, `*` não) como expressão regular."""
    saida = []
    i = 0
    while i < len(glob):
        if glob.startswith("**/", i):
            saida.append("(?:.*/)?")
            i += 3
        elif glob.startswith("**", i):
            saida.append(".*")
            i += 2
        elif glob[i] == "*":
            saida.append("[^/]*")
            i += 1
        else:
            saida.append(re.escape(glob[i]))
            i += 1
    return re.compile("".join(saida) + r"\Z")


def casa(caminho: str, globs: tuple[str, ...]) -> bool:
    """O caminho (relativo à raiz, com `/`) casa algum dos globs."""
    return any(_regex_do_glob(g).match(caminho) for g in globs)


def pilares_exigidos(arquivos: list[str] | None) -> list[str]:
    """Pilares que o conjunto de arquivos alterados exige; `None` (diff desconhecido) exige todos."""
    if arquivos is None:
        return list(PILARES)
    arquivos = [a.strip().replace("\\", "/") for a in arquivos if a.strip()]
    if any(casa(a, GATILHOS_DE_TODOS) for a in arquivos):
        return list(PILARES)
    return [p for p in PILARES if any(casa(a, FILTROS[p]) for a in arquivos)]


def arquivos_alterados(desde: str, ate: str, repo: str = ".") -> list[str] | None:
    """Arquivos que mudaram de `desde` a `ate`, ou None se o git não consegue dizer."""
    try:
        saida = subprocess.run(  # noqa: S603
            ["git", "-C", repo, "diff", "--name-only", "--no-renames", "-z", f"{desde}..{ate}"],  # noqa: S607
            check=True,
            capture_output=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    return [a for a in saida.decode("utf-8", "replace").split("\0") if a]


def descricao(
    resultados: dict[str, int],
    duracao_s: int,
    log: str,
    dispensados: tuple[str, ...] = (),
    desde: str = "",
) -> tuple[str, str]:
    """(estado, descrição) do status a partir do código de saída de cada pilar.

    Os `dispensados` são os pilares que o diff desde o último SHA verde (`desde`) não exigiu: não
    contam como faltando e a descrição diz quais rodaram e quantos ficaram de fora.
    """
    falharam = [p for p in PILARES if resultados.get(p, 0) != 0]
    faltam = [p for p in PILARES if p not in resultados and p not in dispensados]
    if falharam:
        estado, resumo = "failure", "falhou: " + ", ".join(falharam)
    elif faltam:
        estado, resumo = "error", "sem prova: " + ", ".join(faltam)
    elif dispensados:
        rodaram = [p for p in PILARES if p in resultados]
        base = f"{len(rodaram)} verdes ({', '.join(rodaram)})" if rodaram else "nenhum pilar exigido"
        estado, resumo = "success", f"{base}; {len(dispensados)} dispensados desde {desde[:7] or 'o último verde'}"
    else:
        estado, resumo = "success", f"{len(PILARES)} pilares verdes"
    texto = f"{resumo} · {_duracao(duracao_s)} · log {log}"
    if len(texto) > LIMITE_DESCRICAO:
        cauda = f" · {_duracao(duracao_s)}"
        texto = resumo[: LIMITE_DESCRICAO - len(cauda) - 1] + "…" + cauda
    return estado, texto


def ler_resultados(linhas: list[str]) -> dict[str, int]:
    """`<pilar> <código>` por linha → {pilar: código}; linha vazia é ignorada."""
    resultados: dict[str, int] = {}
    for linha in linhas:
        partes = linha.split()
        if not partes:
            continue
        if len(partes) != 2 or partes[0] not in PILARES or not partes[1].isdigit():  # noqa: PLR2004
            raise ValueError(f"linha de resultado inválida: {linha!r}")
        resultados[partes[0]] = int(partes[1])
    return resultados


def alvos_do_push(linhas: list[str]) -> list[str]:
    """SHAs empurrados para `refs/heads/main` (formato do stdin do pre-push), sem a ref apagada."""
    alvos = []
    for linha in linhas:
        partes = linha.split()
        if len(partes) != 4:  # noqa: PLR2004
            continue
        _ref_local, sha_local, ref_remota, _sha_remoto = partes
        if ref_remota == ALVO and sha_local != SHA_NULO:
            alvos.append(sha_local)
    return alvos


def main(argv: list[str] | None = None) -> int:
    """Ponto de entrada da linha de comando."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="comando", required=True)
    sub.add_parser("decidir")
    desc = sub.add_parser("descricao")
    desc.add_argument("--duracao", type=int, default=0)
    desc.add_argument("--log", default="")
    desc.add_argument("--dispensados", default="")
    desc.add_argument("--desde", default="")
    pil = sub.add_parser("pilares")
    pil.add_argument("--desde", default="")
    pil.add_argument("--sha", default="HEAD")
    pil.add_argument("--repo", default=".")
    pil.add_argument("--todos", action="store_true")
    pil.add_argument("--stdin", action="store_true")
    sub.add_parser("alvos-do-push")
    args = parser.parse_args(argv)
    # O Python da estação Windows escreveria no código de página do console.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if args.comando == "pilares":
        arquivos: list[str] | None = None
        if args.stdin and not args.todos:
            arquivos = sys.stdin.read().splitlines()
        elif args.desde and not args.todos:
            arquivos = arquivos_alterados(args.desde, args.sha, args.repo)
        sys.stdout.writelines(f"{p}\n" for p in pilares_exigidos(arquivos))
        return 0
    entrada = sys.stdin.read()

    if args.comando == "decidir":
        try:
            combinado = json.loads(entrada or "{}")
        except json.JSONDecodeError:
            combinado = {}
        liberado, mensagem = decidir(combinado)
        sys.stdout.write(mensagem + "\n")
        return 0 if liberado else 1
    if args.comando == "descricao":
        dispensados = tuple(p for p in args.dispensados.split(",") if p)
        estado, texto = descricao(ler_resultados(entrada.splitlines()), args.duracao, args.log, dispensados, args.desde)
        sys.stdout.write(f"{estado}\n{texto}\n")
        return 0
    sys.stdout.writelines(f"{sha}\n" for sha in alvos_do_push(entrada.splitlines()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
