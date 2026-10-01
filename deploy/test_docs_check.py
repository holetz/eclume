# ruff: noqa: INP001, S101  # testes soltos dos scripts de deploy; deploy/ não é pacote Python
"""Testes do `docs_check.py`: cada problema provado num repositório de mentira."""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest
import yaml

_spec = importlib.util.spec_from_file_location("docs_check", Path(__file__).with_name("docs_check.py"))
assert _spec is not None
assert _spec.loader is not None
docs_check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(docs_check)


def repo(tmp_path: Path, arquivos: dict[str, str]) -> Path:
    """Um repositório de mentira com os arquivos dados."""
    for nome, texto in arquivos.items():
        caminho = tmp_path / nome
        caminho.parent.mkdir(parents=True, exist_ok=True)
        caminho.write_text(texto, encoding="utf-8")
    return tmp_path


@pytest.fixture(autouse=True)
def sem_excecoes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Os testes declaram as próprias exceções; as do repositório não valem aqui."""
    monkeypatch.setattr(docs_check, "EXCECOES", ())


@pytest.mark.parametrize(
    ("titulo", "esperado"),
    [
        ("Gravação, data, natureza e marcadores", "gravação-data-natureza-e-marcadores"),
        ("CI e gate — `deploy/pilares.sh` e `deploy/gate.sh`", "ci-e-gate--deploypilaressh-e-deploygatesh"),
        ("Fixação da CA pelos apps", "fixação-da-ca-pelos-apps"),
        ("Ver [o contrato](contrato.md) v1", "ver-o-contrato-v1"),
    ],
)
def test_slug_no_estilo_do_github(titulo: str, esperado: str) -> None:
    """Minúsculas, acento mantido, pontuação fora, espaço vira hífen; crase e link viram texto."""
    assert docs_check.slug(titulo) == esperado


def test_titulo_repetido_ganha_sufixo() -> None:
    """O segundo título igual vira `-1`, como no GitHub."""
    assert docs_check.ancoras("# Uso\n\n## Uso\n") == {"uso", "uso-1"}


def test_link_para_arquivo_ou_ancora_que_nao_existe(tmp_path: Path) -> None:
    """Link relativo, absoluto ou só âncora é conferido; externo não."""
    raiz = repo(
        tmp_path,
        {
            "docs/a.md": "# A\n\n## Parte boa\n",
            "docs/b.md": (
                "# B\n\n[ok](a.md#parte-boa) [abs](/docs/a.md) [web](https://x.y/z)\n"
                "[sumiu](c.md)\n[âncora](a.md#parte-ruim)\n[aqui](#b) [aqui não](#c)\n"
            ),
        },
    )
    assert docs_check.verificar(raiz) == [
        "docs/b.md:4: link para c.md, que não existe",
        "docs/b.md:5: âncora #parte-ruim não existe em docs/a.md",
        "docs/b.md:6: âncora #c não existe em docs/b.md",
    ]


def test_link_em_codigo_nao_conta(tmp_path: Path) -> None:
    """Link dentro de crase ou de bloco de código é exemplo, não link."""
    raiz = repo(tmp_path, {"docs/a.md": "# A\n\n`[x](nada.md)`\n\n```\n[y](nada.md)\n```\n"})
    assert docs_check.verificar(raiz) == []


def test_caminho_em_crase_que_nao_existe(tmp_path: Path) -> None:
    """Caminho que começa por pasta de topo é conferido (`:linha` ignorado); curinga, comando e variável não."""
    raiz = repo(
        tmp_path,
        {
            "deploy/gate.sh": "",
            "docs/a.md": (
                "# A\n\n`deploy/gate.sh:12` `deploy/gate.sh` `deploy/sumiu.sh` `deploy/*.sh`\n"
                "`bash deploy/sumiu.sh` `deploy/<nome>.yml` `$HOME/x` `outra/coisa.txt`\n"
            ),
        },
    )
    assert docs_check.verificar(raiz) == ["docs/a.md:3: caminho `deploy/sumiu.sh` não existe"]


def test_excecao_cobre_o_caminho_e_a_obsoleta_falha(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A exceção vale só no arquivo dela; a que não é mais usada vira problema."""
    raiz = repo(tmp_path, {"deploy/x.sh": "", "docs/a.md": "# A\n\n`deploy/.env`\n"})
    monkeypatch.setattr(
        docs_check,
        "EXCECOES",
        (
            docs_check.Excecao("docs/a.md", "deploy/.env", "fora do git"),
            docs_check.Excecao("docs/a.md", "deploy/velho", "não citado mais"),
        ),
    )
    assert docs_check.verificar(raiz) == [
        "exceção obsoleta: `deploy/velho` em docs/a.md (não citado mais); tire-a de EXCECOES",
    ]


def test_glossario_em_ordem_sem_caixa_nem_acento() -> None:
    """A ordem ignora caixa e acento; a entrada fora de ordem é apontada."""
    texto = (
        "# Glossário\n\n## Terms\n\n- **Ágora** — a\n- [banco](x.md) — b\n- **Canto** — c\n"
        "- **bola** — d\n\n## Outra\n\n- **Zeta**\n- **alfa**\n"
    )
    assert docs_check.problemas_do_glossario(texto) == [
        "docs/glossary.md:8: 'bola' fora da ordem alfabética (depois de 'Canto')",
    ]


def test_quenching_na_mesma_ref_no_gate_e_na_ci() -> None:
    """O `cq` do pilar `docs` é o mesmo commit do holetz/quenching na imagem do gate e no job da CI."""
    raiz = Path(__file__).resolve().parent.parent
    dockerfile = (raiz / "deploy/gate.Dockerfile").read_text(encoding="utf-8")
    ci = yaml.safe_load((raiz / ".github/workflows/ci.yml").read_text(encoding="utf-8"))
    gate = re.search(r"^ARG QUENCHING_SHA=([0-9a-f]{40})$", dockerfile, re.MULTILINE)
    assert gate is not None
    refs = [
        passo["with"]["ref"]
        for passo in ci["jobs"]["docs"]["steps"]
        if (passo.get("with") or {}).get("repository") == "holetz/quenching"
    ]
    assert refs == [gate[1]]
    assert any("bash deploy/pilares.sh docs" in str(passo.get("run", "")) for passo in ci["jobs"]["docs"]["steps"])
