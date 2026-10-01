# ruff: noqa: INP001  # script solto, chamado pelo teste, pelo deploy e pelos releases; deploy/ não é pacote Python
"""Versões do eclume: as três linhas, seus manifestos e seus CHANGELOGs, só com a stdlib.

Linhas (docs/standards/code/versionamento.md):

- `produto` — server, worker GPU, engines e web: os três `pyproject.toml`, o `web/package.json`,
  o `web/package-lock.json` e os membros no `uv.lock`; o `CHANGELOG.md` da raiz;
- `desktop` — `desktop/src-tauri/tauri.conf.json`, a `[workspace.package]` do `desktop/Cargo.toml`
  e os crates dela nos `Cargo.lock`; o `desktop/CHANGELOG.md`;
- `movel` — o mesmo em `mobile/`; o `mobile/CHANGELOG.md`.

Uso:
    python3 deploy/versao.py atual <linha>              # a versão da linha
    python3 deploy/versao.py definir <linha> <versão>   # grava a versão em todos os manifestos
    python3 deploy/versao.py conferir                   # sai com 1 se algo diverge
    python3 deploy/versao.py notas <linha> <versão>     # o corpo da seção (ou "Não lançado")
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
NAO_LANCADO = "Não lançado"
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
SECAO = re.compile(r"^## \[(?P<nome>[^\]]+)\](?: - (?P<data>\d{4}-\d{2}-\d{2}))?\s*$", re.MULTILINE)
MIGRATIONS = "server/src/eclume_server/db/migrations"
PYPROJECTS = {
    "server/pyproject.toml": "eclume-server",
    "engines/pyproject.toml": "eclume-engines",
    "worker-gpu/pyproject.toml": "eclume-worker",
}
INITS = (
    "server/src/eclume_server/__init__.py",
    "engines/src/eclume_engines/__init__.py",
    "worker-gpu/src/eclume_worker/__init__.py",
)
LOCKS_CARGO = ("desktop/Cargo.lock", "mobile/Cargo.lock")


APPS = {"desktop": "desktop", "movel": "mobile"}  # linha → pasta do workspace Cargo com o Tauri
LINHAS = ("produto", *APPS)
CHANGELOGS = {"produto": "CHANGELOG.md", "desktop": "desktop/CHANGELOG.md", "movel": "mobile/CHANGELOG.md"}


def _ler(raiz: Path, rel: str) -> str:
    return (raiz / rel).read_text(encoding="utf-8")


def _gravar(raiz: Path, rel: str, texto: str) -> None:
    (raiz / rel).write_text(texto, encoding="utf-8", newline="\n")


# --- campos de versão: cada um lido e regravado por expressão, sem reformatar o arquivo ------------

_PYPROJECT = re.compile(r'(?m)^(version = ")([^"]*)(")')
_JSON_VERSAO = re.compile(r'(?m)^(  "version": ")([^"]*)(")')
_WORKSPACE = re.compile(r'(?ms)^(\[workspace\.package\]\n(?:(?!\[).*\n)*?version = ")([^"]*)(")')


def _pacote_lock(nome: str) -> re.Pattern[str]:
    """O `version` de um `[[package]]` local de nome dado: no `Cargo.lock`, sem `source`; no `uv.lock`, editável."""
    cabeca = rf'(?m)^(\[\[package\]\]\nname = "{re.escape(nome)}"\nversion = ")'
    return re.compile(cabeca + r'([^"]*)("\n(?!source = "))')


def _crates(raiz: Path, pasta: str) -> list[str]:
    """Os crates do workspace do app que herdam a versão dele (`version.workspace = true`)."""
    membros = re.search(r"(?ms)^members = \[(.*?)\]", _ler(raiz, f"{pasta}/Cargo.toml"))
    nomes = []
    for membro in re.findall(r'"([^"]+)"', membros.group(1) if membros else ""):
        manifesto = _ler(raiz, f"{pasta}/{membro}/Cargo.toml")
        nome = re.search(r'(?m)^name = "([^"]+)"', manifesto)
        if nome and re.search(r"(?m)^version\.workspace = true", manifesto):
            nomes.append(nome.group(1))
    return nomes


def _campos(raiz: Path, linha: str) -> list[tuple[str, re.Pattern[str], str]]:
    """Os campos da linha: (arquivo, expressão com o valor no grupo 2, rótulo)."""
    if linha == "produto":
        campos = [(rel, _PYPROJECT, rel) for rel in PYPROJECTS]
        campos += [(rel, _JSON_VERSAO, rel) for rel in ("web/package.json", "web/package-lock.json")]
        lock_web = re.compile(r'(?m)^(    "": \{\n      "name": "eclume-web",\n      "version": ")([^"]*)(")')
        campos.append(("web/package-lock.json", lock_web, 'web/package-lock.json packages[""]'))
        campos += [("uv.lock", _pacote_lock(nome), f"uv.lock {nome}") for nome in PYPROJECTS.values()]
        return campos
    pasta = APPS[linha]
    tauri, cargo = f"{pasta}/src-tauri/tauri.conf.json", f"{pasta}/Cargo.toml"
    campos = [(tauri, _JSON_VERSAO, tauri), (cargo, _WORKSPACE, f"{cargo} [workspace.package]")]
    for nome in _crates(raiz, pasta):
        for lock in LOCKS_CARGO:
            if _pacote_lock(nome).search(_ler(raiz, lock)):
                campos.append((lock, _pacote_lock(nome), f"{lock} {nome}"))
    return campos


def _valores(raiz: Path, linha: str) -> list[tuple[str, str | None]]:
    """O valor de cada campo da linha (`None` quando o campo some)."""
    valores = []
    for rel, padrao, rotulo in _campos(raiz, linha):
        achado = padrao.search(_ler(raiz, rel))
        valores.append((rotulo, achado.group(2) if achado else None))
    return valores


def atual(raiz: Path, linha: str) -> str:
    """A versão da linha: a do primeiro campo dela (o `server/pyproject.toml` ou o `tauri.conf.json`)."""
    valor = _valores(raiz, linha)[0][1]
    if valor is None:
        msg = f"sem versão em {_campos(raiz, linha)[0][2]}"
        raise ValueError(msg)
    return valor


def definir(raiz: Path, linha: str, versao: str) -> list[str]:
    """Grava a versão em todos os campos da linha e devolve os arquivos tocados."""
    if not SEMVER.match(versao):
        msg = f"versão fora do SemVer X.Y.Z: {versao}"
        raise ValueError(msg)
    tocados: list[str] = []
    for rel, padrao, rotulo in _campos(raiz, linha):
        texto = _ler(raiz, rel)
        novo, n = padrao.subn(lambda m: m.group(1) + versao + m.group(3), texto, count=1)
        if n == 0:
            msg = f"campo de versão não encontrado: {rotulo}"
            raise ValueError(msg)
        if novo != texto:
            _gravar(raiz, rel, novo)
        if rel not in tocados:
            tocados.append(rel)
    return tocados


# --- CHANGELOG -------------------------------------------------------------------------------------


def secoes(texto: str) -> dict[str, str]:
    """As seções `## [nome]` do CHANGELOG, na ordem, com o corpo de cada uma sem as bordas em branco."""
    achados = list(SECAO.finditer(texto))
    return {
        m.group("nome"): texto[m.end() : achados[i + 1].start() if i + 1 < len(achados) else len(texto)].strip()
        for i, m in enumerate(achados)
    }


def notas(raiz: Path, linha: str, versao: str) -> str:
    """O corpo da seção da versão no CHANGELOG da linha; vazio só vale para `Não lançado`."""
    corpo = secoes(_ler(raiz, CHANGELOGS[linha])).get(versao)
    if corpo is None:
        msg = f"{CHANGELOGS[linha]} não tem a seção [{versao}]"
        raise ValueError(msg)
    if not corpo and versao != NAO_LANCADO:
        msg = f"{CHANGELOGS[linha]}: a seção [{versao}] está vazia"
        raise ValueError(msg)
    return corpo


def _conferir_changelog(raiz: Path, linha: str, versao: str) -> list[str]:
    rel = CHANGELOGS[linha]
    if not (raiz / rel).exists():
        return [f"falta {rel}"]
    nomes = list(secoes(_ler(raiz, rel)))
    problemas = []
    if not nomes or nomes[0] != NAO_LANCADO:
        problemas.append(f"{rel}: a primeira seção tem de ser [{NAO_LANCADO}]")
    if versao not in nomes:
        problemas.append(f"{rel}: falta a seção [{versao}] da versão atual de {linha}")
    problemas += [f"{rel}: seção [{n}] fora do SemVer X.Y.Z" for n in nomes if n != NAO_LANCADO and not SEMVER.match(n)]
    if len(set(nomes)) != len(nomes):
        problemas.append(f"{rel}: seção repetida")
    return problemas


def conferir(raiz: Path) -> list[str]:
    """Os problemas da árvore: campos divergentes, versão sem seção, migration sem entrada."""
    problemas = []
    for linha in LINHAS:
        valores = _valores(raiz, linha)
        problemas += [f"{linha}: sem versão em {rotulo}" for rotulo, valor in valores if valor is None]
        distintos = {valor for _, valor in valores if valor is not None}
        if len(distintos) > 1:
            detalhe = ", ".join(f"{rotulo}={valor}" for rotulo, valor in valores)
            problemas.append(f"{linha}: versões divergentes ({detalhe}); rode deploy/versao.py definir")
        if valores[0][1] is not None:
            problemas += _conferir_changelog(raiz, linha, valores[0][1])
    for rel in INITS:
        if re.search(r'(?m)^__version__ = ["\']', _ler(raiz, rel)):
            problemas.append(f"{rel}: __version__ literal; leia de importlib.metadata.version")
    if (raiz / CHANGELOGS["produto"]).exists():
        texto = _ler(raiz, CHANGELOGS["produto"])
        for sql in sorted((raiz / MIGRATIONS).glob("*.sql")):
            if sql.stem not in texto:
                problemas.append(f"{CHANGELOGS['produto']}: nenhuma entrada cita a migration {sql.stem}")
    return problemas


def main(argv: list[str] | None = None) -> int:
    """Roda o subcomando pedido."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--raiz", type=Path, default=RAIZ, help="raiz do repositório (padrão: a deste script)")
    sub = parser.add_subparsers(dest="comando", required=True)
    sub.add_parser("atual", help="a versão da linha").add_argument("linha", choices=LINHAS)
    p_definir = sub.add_parser("definir", help="grava a versão em todos os manifestos da linha")
    p_definir.add_argument("linha", choices=LINHAS)
    p_definir.add_argument("versao")
    sub.add_parser("conferir", help="sai com 1 se versões, CHANGELOGs ou migrations divergem")
    p_notas = sub.add_parser("notas", help="o corpo da seção da versão no CHANGELOG da linha")
    p_notas.add_argument("linha", choices=LINHAS)
    p_notas.add_argument("versao")
    args = parser.parse_args(argv)

    try:
        if args.comando == "atual":
            sys.stdout.write(atual(args.raiz, args.linha) + "\n")
        elif args.comando == "definir":
            for rel in definir(args.raiz, args.linha, args.versao):
                sys.stdout.write(f"gravado {rel}\n")
        elif args.comando == "notas":
            corpo = notas(args.raiz, args.linha, args.versao)
            sys.stdout.write(corpo + "\n" if corpo else "")
        else:
            problemas = conferir(args.raiz)
            for problema in problemas:
                sys.stderr.write(f"{problema}\n")
            if problemas:
                return 1
            versoes = ", ".join(f"{linha} {atual(args.raiz, linha)}" for linha in LINHAS)
            sys.stdout.write(f"versões em dia: {versoes}\n")
    except (ValueError, OSError) as erro:
        sys.stderr.write(f"{erro}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
