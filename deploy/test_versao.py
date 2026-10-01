# ruff: noqa: INP001, S101  # testes soltos dos scripts de deploy; deploy/ não é pacote Python
"""Testes do `versao.py`: as três linhas andam juntas, cada versão tem seção e cada migration, entrada."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("versao", Path(__file__).with_name("versao.py"))
assert _spec is not None
assert _spec.loader is not None
versao = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(versao)

RAIZ = Path(__file__).resolve().parent.parent

CHANGELOG_PRODUTO = """# Changelog do eclume

## [Não lançado]

## [0.1.0] - 2026-09-30

### Adicionado

- Primeira versão.

### Para quem hospeda

- Migrations: `001_nucleo`.
"""


def _escrever(raiz: Path, rel: str, texto: str) -> None:
    caminho = raiz / rel
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(texto, encoding="utf-8", newline="\n")


def _lock_cargo(pacotes: dict[str, str]) -> str:
    externo = '[[package]]\nname = "serde"\nversion = "0.4.0"\nsource = "registry+https://github.com/x"\n\n'
    locais = "".join(f'[[package]]\nname = "{n}"\nversion = "{v}"\ndependencies = []\n\n' for n, v in pacotes.items())
    return "version = 4\n\n" + externo + locais


def arvore(raiz: Path) -> Path:
    """Uma árvore mínima com os manifestos das três linhas, em dia."""
    for rel, nome in versao.PYPROJECTS.items():
        _escrever(raiz, rel, f'[project]\nname = "{nome}"\nversion = "0.1.0"\n\n[tool.x]\nversion = "9.9.9"\n')
    for rel in versao.INITS:
        _escrever(raiz, rel, 'from importlib.metadata import version\n\n__version__ = version("x")\n')
    _escrever(raiz, "web/package.json", '{\n  "name": "eclume-web",\n  "version": "0.1.0"\n}\n')
    _escrever(
        raiz,
        "web/package-lock.json",
        '{\n  "name": "eclume-web",\n  "version": "0.1.0",\n  "packages": {\n'
        '    "": {\n      "name": "eclume-web",\n      "version": "0.1.0"\n    },\n'
        '    "node_modules/a": {\n      "version": "0.1.0"\n    }\n  }\n}\n',
    )
    uv = "version = 1\n\n"
    for nome, pasta in zip(versao.PYPROJECTS.values(), ("server", "engines", "worker-gpu"), strict=True):
        uv += f'[[package]]\nname = "{nome}"\nversion = "0.1.0"\nsource = {{ editable = "{pasta}" }}\n\n'
    _escrever(raiz, "uv.lock", uv)
    for pasta, v, crates in (
        ("desktop", "0.4.0", ["eclume-desktop", "eclume-sync"]),
        ("mobile", "0.1.0", ["eclume-mobile"]),
    ):
        membros = ", ".join(f'"m{i}"' for i in range(len(crates)))
        _escrever(
            raiz, f"{pasta}/Cargo.toml", f'[workspace]\nmembers = [{membros}]\n\n[workspace.package]\nversion = "{v}"\n'
        )
        for i, crate in enumerate(crates):
            _escrever(raiz, f"{pasta}/m{i}/Cargo.toml", f'[package]\nname = "{crate}"\nversion.workspace = true\n')
        _escrever(
            raiz, f"{pasta}/src-tauri/tauri.conf.json", f'{{\n  "productName": "eclume",\n  "version": "{v}"\n}}\n'
        )
    _escrever(raiz, "desktop/Cargo.lock", _lock_cargo({"eclume-desktop": "0.4.0", "eclume-sync": "0.4.0"}))
    _escrever(raiz, "mobile/Cargo.lock", _lock_cargo({"eclume-mobile": "0.1.0", "eclume-sync": "0.4.0"}))
    _escrever(raiz, f"{versao.MIGRATIONS}/001_nucleo.sql", "select 1;\n")
    _escrever(raiz, "CHANGELOG.md", CHANGELOG_PRODUTO)
    _escrever(raiz, "desktop/CHANGELOG.md", "# Desktop\n\n## [Não lançado]\n\n## [0.4.0] - 2026-09-30\n\n- Bandeja.\n")
    _escrever(raiz, "mobile/CHANGELOG.md", "# Celular\n\n## [Não lançado]\n\n## [0.1.0] - 2026-09-27\n\n- Gravador.\n")
    return raiz


def test_arvore_em_dia_nao_tem_problemas(tmp_path: Path) -> None:
    """A árvore com tudo amarrado passa e cada linha diz a própria versão."""
    raiz = arvore(tmp_path)
    assert versao.conferir(raiz) == []
    assert [versao.atual(raiz, linha) for linha in versao.LINHAS] == ["0.1.0", "0.4.0", "0.1.0"]


def test_definir_produto_move_todos_os_campos_e_so_eles(tmp_path: Path) -> None:
    """O `definir` do produto move os manifestos e os locks, sem tocar em outro `version`."""
    raiz = arvore(tmp_path)
    tocados = versao.definir(raiz, "produto", "0.2.0")
    assert set(tocados) == {*versao.PYPROJECTS, "web/package.json", "web/package-lock.json", "uv.lock"}
    assert {v for _, v in versao._valores(raiz, "produto")} == {"0.2.0"}  # noqa: SLF001
    assert 'version = "9.9.9"' in (raiz / "server/pyproject.toml").read_text(encoding="utf-8")
    assert '"node_modules/a": {\n      "version": "0.1.0"' in (raiz / "web/package-lock.json").read_text(
        encoding="utf-8"
    )
    assert versao.conferir(raiz) == ["CHANGELOG.md: falta a seção [0.2.0] da versão atual de produto"]


def test_definir_desktop_alcanca_os_crates_dele_nos_dois_locks(tmp_path: Path) -> None:
    """Os crates do desktop sobem também no lock do celular, que os usa por caminho."""
    raiz = arvore(tmp_path)
    versao.definir(raiz, "desktop", "0.5.0")
    movel = (raiz / "mobile/Cargo.lock").read_text(encoding="utf-8")
    assert 'name = "eclume-sync"\nversion = "0.5.0"' in movel
    assert 'name = "eclume-mobile"\nversion = "0.1.0"' in movel
    assert 'name = "serde"\nversion = "0.4.0"' in (raiz / "desktop/Cargo.lock").read_text(encoding="utf-8")
    assert versao.atual(raiz, "movel") == "0.1.0"


def test_definir_recusa_versao_fora_do_semver(tmp_path: Path) -> None:
    """Só `X.Y.Z` entra."""
    with pytest.raises(ValueError, match="SemVer"):
        versao.definir(arvore(tmp_path), "produto", "0.2")


def test_conferir_acusa_campo_divergente(tmp_path: Path) -> None:
    """Um campo fora do passo acusa a linha, e a versão nova sem seção também."""
    raiz = arvore(tmp_path)
    tauri = raiz / "mobile/src-tauri/tauri.conf.json"
    tauri.write_text(tauri.read_text(encoding="utf-8").replace("0.1.0", "0.1.1"), encoding="utf-8")
    divergencia, sem_secao = versao.conferir(raiz)
    assert divergencia.startswith("movel: versões divergentes")
    assert sem_secao == "mobile/CHANGELOG.md: falta a seção [0.1.1] da versão atual de movel"


def test_conferir_acusa_versao_literal(tmp_path: Path) -> None:
    """O `__version__` volta a ser literal: acusado."""
    raiz = arvore(tmp_path)
    _escrever(raiz, versao.INITS[1], '__version__ = "0.1.0"\n')
    assert versao.conferir(raiz) == [f"{versao.INITS[1]}: __version__ literal; leia de importlib.metadata.version"]


def test_conferir_acusa_migration_sem_entrada(tmp_path: Path) -> None:
    """Migration que nenhuma entrada do produto cita é acusada."""
    raiz = arvore(tmp_path)
    _escrever(raiz, f"{versao.MIGRATIONS}/002_agentes.sql", "select 1;\n")
    assert versao.conferir(raiz) == ["CHANGELOG.md: nenhuma entrada cita a migration 002_agentes"]


def test_conferir_exige_nao_lancado_no_topo(tmp_path: Path) -> None:
    """O CHANGELOG abre por `[Não lançado]`."""
    raiz = arvore(tmp_path)
    _escrever(raiz, "CHANGELOG.md", CHANGELOG_PRODUTO.replace("## [Não lançado]\n\n", ""))
    assert versao.conferir(raiz) == ["CHANGELOG.md: a primeira seção tem de ser [Não lançado]"]


def test_notas_devolve_o_corpo_da_secao(tmp_path: Path) -> None:
    """As notas são o corpo da seção; `Não lançado` pode vir vazio."""
    raiz = arvore(tmp_path)
    assert versao.notas(raiz, "desktop", "0.4.0") == "- Bandeja."
    assert versao.notas(raiz, "produto", versao.NAO_LANCADO) == ""
    with pytest.raises(ValueError, match=r"não tem a seção \[0\.9\.9\]"):
        versao.notas(raiz, "desktop", "0.9.9")


def test_notas_recusa_secao_vazia(tmp_path: Path) -> None:
    """Versão numerada sem corpo não vira nota de release."""
    raiz = arvore(tmp_path)
    _escrever(raiz, "mobile/CHANGELOG.md", "# Celular\n\n## [Não lançado]\n\n## [0.1.0] - 2026-09-27\n")
    with pytest.raises(ValueError, match="vazia"):
        versao.notas(raiz, "movel", "0.1.0")


def test_main_conferir_e_notas(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """A linha de comando: notas na saída, divergência no erro com código 1."""
    raiz = arvore(tmp_path)
    assert versao.main(["--raiz", str(raiz), "notas", "produto", "0.1.0"]) == 0
    assert capsys.readouterr().out.startswith("### Adicionado")
    assert versao.main(["--raiz", str(raiz), "definir", "movel", "0.2.0"]) == 0
    capsys.readouterr()
    assert versao.main(["--raiz", str(raiz), "conferir"]) == 1
    assert "falta a seção [0.2.0]" in capsys.readouterr().err


def test_o_repositorio_esta_em_dia() -> None:
    """O `conferir` sobre a árvore real: manifestos, CHANGELOGs e migrations amarrados."""
    assert versao.conferir(RAIZ) == []
