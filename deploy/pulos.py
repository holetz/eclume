# ruff: noqa: INP001, T201, S314  # script solto, chamado pelo pilar e pelo teste; deploy/ não é pacote Python
"""Confere os pulos do pytest contra a lista versionada de pulos esperados.

Uso: python3 deploy/pulos.py <junit.xml> <lista.txt>

Cada linha da lista é `<arquivo>::<teste> | <motivo>` (`#` comenta). Falha (saída 1) em pulo fora da
lista e em pulo listado que deixou de ocorrer, para a lista não apodrecer.
Contrato: docs/standards/code/monorepo.md.
"""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ARGS = 3  # o script, o relatório e a lista


def ler_lista(texto: str) -> set[str]:
    """As chaves `<arquivo>::<teste>` da lista, sem comentários nem linhas vazias."""
    chaves: set[str] = set()
    for bruta in texto.splitlines():
        linha = bruta.split("#", 1)[0].strip()
        if linha:
            chaves.add(linha.split("|", 1)[0].strip())
    return chaves


def ler_pulos(xml: str) -> dict[str, str]:
    """Os pulos do relatório junit: chave `<arquivo>::<teste>` e o motivo."""
    pulos: dict[str, str] = {}
    for caso in ET.fromstring(xml).iter("testcase"):
        pulo = caso.find("skipped")
        if pulo is None:
            continue
        modulo = (caso.get("classname") or "").replace(".", "/")
        pulos[f"{modulo}::{caso.get('name')}"] = pulo.get("message") or ""
    return pulos


def comparar(pulos: dict[str, str], esperados: set[str]) -> list[str]:
    """Os problemas: pulo sem registro e pulo registrado que não ocorreu."""
    problemas = [
        f"pulo não documentado: {chave} ({motivo})"
        for chave, motivo in sorted(pulos.items())
        if _fora(chave, esperados)
    ]
    problemas += [
        f"pulo esperado que não ocorreu (lista apodrecida): {e}" for e in sorted(esperados) if not _ocorreu(e, pulos)
    ]
    return problemas


def _casa(esperado: str, chave: str) -> bool:
    # `arquivo::teste` casa o sufixo da chave (o junit traz o caminho completo do módulo).
    modulo, _, teste = esperado.partition("::")
    mod_chave, _, teste_chave = chave.partition("::")
    return teste == teste_chave and mod_chave.endswith(modulo.removesuffix(".py"))


def _fora(chave: str, esperados: set[str]) -> bool:
    return not any(_casa(e, chave) for e in esperados)


def _ocorreu(esperado: str, pulos: dict[str, str]) -> bool:
    return any(_casa(esperado, c) for c in pulos)


def main(argv: list[str]) -> int:
    """Compara o relatório com a lista e devolve a saída do processo."""
    if len(argv) != ARGS:
        print(__doc__)
        return 2
    problemas = comparar(ler_pulos(Path(argv[1]).read_text()), ler_lista(Path(argv[2]).read_text()))
    for p in problemas:
        print(f"ERRO: {p}")
    if not problemas:
        print("Pulos do pytest: só os documentados.")
    return 1 if problemas else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
