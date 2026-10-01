# ruff: noqa: INP001  # script solto, chamado pelo pilar `docs` e pelo teste; deploy/ não é pacote
"""Checagem da documentação do eclume, só com a stdlib.

Varre `docs/**/*.md`, os `.md` da raiz e os `README.md`/`INSTALACAO.md` dos pilares e acusa:

- link relativo para arquivo que não existe, ou com `#âncora` para título que não existe no alvo
  (slug no estilo do GitHub: minúsculas, acento mantido, pontuação fora, espaço vira hífen);
- caminho em crase que começa por uma pasta de topo do repositório (sem curinga, `<`, `{` ou `$`)
  e não existe (o `:linha` do fim é ignorado);
- entrada do glossário fora da ordem alfabética (sem caixa nem acento).

Links para fora (`http:`, `https:`, `mailto:`) não são seguidos. As exceções vivem em `EXCECOES`,
cada uma com o motivo; uma exceção que deixa de ser necessária também falha.

Uso: python3 deploy/docs_check.py [--raiz .]   (sai 1 e lista os problemas, se houver)
Contrato: docs/standards/code/monorepo.md.
"""

from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from itertools import pairwise
from pathlib import Path
from typing import NamedTuple


class Excecao(NamedTuple):
    """Um caminho em crase que não existe no repositório, de propósito."""

    arquivo: str
    caminho: str
    motivo: str


EXCECOES: tuple[Excecao, ...] = (
    Excecao("docs/project/deploy-producao.md", "deploy/.deploy.lock.d", "trava criada pelo deploy.sh em execução"),
    Excecao("docs/project/deploy-producao.md", "deploy/.env.remote", "arquivo do repositório do lumea"),
    Excecao("docs/standards/code/monorepo.md", "mobile/.cargo/config.toml", "exemplo do que não existe, de propósito"),
    Excecao("deploy/README.md", "deploy/.env", "criado pela pessoa a partir do .env.example; fora do git"),
    Excecao("deploy/README.md", "deploy/.env.prod", "segredos gerados pelo deploy.sh --gerar-env; fora do git"),
    Excecao(
        "docs/project/deploy-producao.md",
        "deploy/.env.prod",
        "segredos gerados pelo deploy.sh --gerar-env; fora do git",
    ),
    Excecao(
        "docs/standards/code/mobile-distribuicao.md",
        "mobile/certificado-release.sha256",
        "versionado no primeiro release, com a keystore criada pela dona (#108 5.1)",
    ),
    Excecao(
        "docs/how-to/auto-hospedar.md", "deploy/.env.prod", "segredos gerados pelo deploy.sh --gerar-env; fora do git"
    ),
    Excecao(
        "docs/how-to/desenvolver-sem-gpu.md", "deploy/.env", "criado pela pessoa a partir do .env.example; fora do git"
    ),
    Excecao("docs/project/deploy-producao.md", "web/test-results/prod", "saída da prova de produção do Playwright"),
    Excecao(
        "docs/standards/agents/communication.md",
        "docs/standards/CLAUDE.md",
        "exemplo hipotético de CLAUDE.md por pasta",
    ),
    Excecao("docs/standards/agents/communication.md", "web/CLAUDE.md", "exemplo hipotético de CLAUDE.md por pasta"),
    Excecao("docs/standards/agents/communication.md", "deploy/CLAUDE.md", "exemplo hipotético de CLAUDE.md por pasta"),
)

LINK = re.compile(r"(?<!!)\[(?:[^\]\[]|\[[^\]]*\])*\]\((?P<alvo>[^)\s]+)(?:\s+\"[^\"]*\")?\)")
CRASE = re.compile(r"`(?P<texto>[^`\n]+)`")
TITULO = re.compile(r"^(?P<nivel>#{1,6})\s+(?P<texto>.+?)\s*#*\s*$")
CERCA = re.compile(r"^\s*(```|~~~)")
LINHA_FINAL = re.compile(r":\d+(?:-\d+)?$")
EXTERNO = ("http:", "https:", "mailto:", "tel:")


def slug(titulo: str) -> str:
    """O id que o GitHub dá a um título de Markdown."""
    texto = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", titulo)  # link: fica o texto
    texto = texto.replace("`", "").strip().lower()
    texto = "".join(c for c in texto if c.isalnum() or c in "-_ ")
    return texto.replace(" ", "-")


def linhas_fora_de_codigo(texto: str) -> list[tuple[int, str]]:
    """(número, linha) das linhas fora de blocos de código cercados."""
    saida, dentro = [], False
    for n, linha in enumerate(texto.splitlines(), 1):
        if CERCA.match(linha):
            dentro = not dentro
            continue
        if not dentro:
            saida.append((n, linha))
    return saida


def ancoras(texto: str) -> set[str]:
    """Os slugs dos títulos do documento, com o sufixo `-1`, `-2` dos repetidos."""
    vistos: dict[str, int] = {}
    saida = set()
    for _, linha in linhas_fora_de_codigo(texto):
        if m := TITULO.match(linha):
            base = slug(m["texto"])
            n = vistos.get(base, 0)
            saida.add(base if n == 0 else f"{base}-{n}")
            vistos[base] = n + 1
    return saida


def sem_crase(linha: str) -> str:
    """A linha sem os trechos em crase (links dentro de código não contam)."""
    return CRASE.sub("", linha)


def problemas_de_links(arquivo: Path, raiz: Path, cache: dict[Path, set[str]]) -> list[str]:
    """Links relativos para arquivo ou âncora que não existe."""
    texto = arquivo.read_text(encoding="utf-8")
    rel = arquivo.relative_to(raiz).as_posix()
    problemas = []
    for n, linha in linhas_fora_de_codigo(texto):
        for m in LINK.finditer(sem_crase(linha)):
            alvo = m["alvo"].strip("<>")
            if alvo.startswith(EXTERNO):
                continue
            caminho, _, ancora = alvo.partition("#")
            if caminho.startswith("/"):  # absoluto: a partir da raiz do repositório
                destino = (raiz / caminho.lstrip("/")).resolve()
            else:
                destino = (arquivo.parent / caminho).resolve() if caminho else arquivo
            if caminho and not destino.exists():
                problemas.append(f"{rel}:{n}: link para {caminho}, que não existe")
                continue
            if ancora and destino.suffix == ".md" and destino.is_file():
                if destino not in cache:
                    cache[destino] = ancoras(destino.read_text(encoding="utf-8"))
                if ancora not in cache[destino]:
                    problemas.append(
                        f"{rel}:{n}: âncora #{ancora} não existe em {destino.relative_to(raiz).as_posix()}"
                    )
    return problemas


def caminhos_em_crase(texto: str, pastas_de_topo: set[str]) -> list[tuple[int, str]]:
    """(linha, caminho) dos trechos em crase que parecem caminho do repositório."""
    saida = []
    for n, linha in linhas_fora_de_codigo(texto):
        for m in CRASE.finditer(linha):
            caminho = m["texto"].strip()
            # Curinga, marcador, variável, comando e pasta gerada pelo npm não são caminhos do commit.
            if any(c in caminho for c in "*<>{}$ ") or "/" not in caminho or "node_modules" in caminho:
                continue
            caminho = LINHA_FINAL.sub("", caminho).rstrip("/")
            if caminho.split("/", 1)[0] in pastas_de_topo:
                saida.append((n, caminho))
    return saida


def problemas_de_caminhos(arquivo: Path, raiz: Path, pastas_de_topo: set[str], usadas: set[Excecao]) -> list[str]:
    """Caminhos em crase que não existem, fora das exceções (as usadas entram em `usadas`)."""
    rel = arquivo.relative_to(raiz).as_posix()
    problemas = []
    for n, caminho in caminhos_em_crase(arquivo.read_text(encoding="utf-8"), pastas_de_topo):
        if (raiz / caminho).exists():
            continue
        excecao = next((e for e in EXCECOES if e.arquivo == rel and e.caminho == caminho), None)
        if excecao:
            usadas.add(excecao)
        else:
            problemas.append(f"{rel}:{n}: caminho `{caminho}` não existe")
    return problemas


def chave(termo: str) -> str:
    """A chave de ordenação do glossário: sem caixa e sem acento."""
    sem_acento = unicodedata.normalize("NFKD", termo)
    return "".join(c for c in sem_acento if not unicodedata.combining(c)).casefold()


def termos_do_glossario(texto: str) -> list[tuple[int, str]]:
    """(linha, termo) de cada entrada `- [termo](…)` ou `- **termo**` da seção de termos."""
    saida, na_secao = [], False
    for n, linha in linhas_fora_de_codigo(texto):
        if linha.startswith("## "):
            na_secao = linha.strip() == "## Terms"
            continue
        if na_secao and (m := re.match(r"^- (?:\[(?P<link>[^\]]+)\]|\*\*(?P<negrito>[^*]+)\*\*)", linha)):
            saida.append((n, m["link"] or m["negrito"]))
    return saida


def problemas_do_glossario(texto: str) -> list[str]:
    """Entradas fora da ordem alfabética."""
    termos = termos_do_glossario(texto)
    return [
        f"docs/glossary.md:{n}: '{termo}' fora da ordem alfabética (depois de '{anterior}')"
        for (_, anterior), (n, termo) in pairwise(termos)
        if chave(termo) < chave(anterior)
    ]


def arquivos(raiz: Path) -> list[Path]:
    """Os Markdown conferidos."""
    conjunto = {
        *raiz.glob("docs/**/*.md"),
        *raiz.glob("*.md"),
        *raiz.glob("*/README.md"),
        *raiz.glob("*/INSTALACAO.md"),
    }
    # design-system/ é o export do Claude Design, versionado como veio (em inglês, com os caminhos do
    # projeto de desenho); não é documentação do repositório. No Windows, `*/README.md` casaria o
    # `readme.md` dele.
    fora = {"node_modules", "design-system"}
    return sorted(p for p in conjunto if not fora.intersection(p.relative_to(raiz).parts))


def verificar(raiz: Path) -> list[str]:
    """Todos os problemas da documentação em `raiz`."""
    pastas_de_topo = {p.name for p in raiz.iterdir() if p.is_dir() and p.name not in {".git", "node_modules"}}
    cache: dict[Path, set[str]] = {}
    usadas: set[Excecao] = set()
    problemas: list[str] = []
    for arquivo in arquivos(raiz):
        problemas += problemas_de_links(arquivo, raiz, cache)
        problemas += problemas_de_caminhos(arquivo, raiz, pastas_de_topo, usadas)
    glossario = raiz / "docs/glossary.md"
    if glossario.exists():
        problemas += problemas_do_glossario(glossario.read_text(encoding="utf-8"))
    problemas += [
        f"exceção obsoleta: `{e.caminho}` em {e.arquivo} ({e.motivo}); tire-a de EXCECOES"
        for e in EXCECOES
        if e not in usadas
    ]
    return problemas


def main(argv: list[str] | None = None) -> int:
    """Ponto de entrada da linha de comando."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--raiz", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    problemas = verificar(args.raiz.resolve())
    sys.stdout.writelines(f"{p}\n" for p in problemas)
    return 1 if problemas else 0


if __name__ == "__main__":
    sys.exit(main())
