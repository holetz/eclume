# ruff: noqa: INP001  # script solto, rodado pelo pilar android do gate; mobile/ não é pacote Python
"""Confere a ponte JNI do app móvel do eclume no APK de release.

Cada `external fun` do `EclumeCore.kt` precisa de um símbolo `Java_<pacote>_<classe>_<método>` na
`libeclume_mobile_lib.so` do APK, e o R8 precisa manter a classe e os métodos com o nome no dex
(a regra `-keep` de `consumer-rules.pro`). Um renome do pacote (holetz/eclume#17) ou uma função nova
que só existe de um lado aparece aqui, no gate, em vez de um `UnsatisfiedLinkError` no aparelho.

Uso (o shell do pilar extrai a `.so` do APK e roda as ferramentas do NDK e do SDK):
    python3 mobile/scripts/simbolos_jni.py --kotlin <EclumeCore.kt> --nm <saída do llvm-nm -D> \
        [--dex <saída do apkanalyzer dex packages>]
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

PACOTE = re.compile(r"^\s*package\s+([\w.]+)", re.MULTILINE)
CLASSE = re.compile(r"^\s*(?:object|class)\s+(\w+)", re.MULTILINE)
EXTERNA = re.compile(r"\bexternal\s+fun\s+(\w+)\s*\(")
# Uma linha do `llvm-nm` com símbolo definido tem ao menos o tipo e o nome.
COLUNAS_DO_NM = 2


def mangle(parte: str) -> str:
    """O mangling JNI de um nome: `_` vira `_1` e `.` vira `_` (nomes ASCII, como os do app)."""
    return parte.replace("_", "_1").replace(".", "_")


def ler_kotlin(fonte: str) -> tuple[str, str, list[str]]:
    """O pacote, a classe e as `external fun` de um arquivo Kotlin."""
    pacote = PACOTE.search(fonte)
    classe = CLASSE.search(fonte)
    if not pacote or not classe:
        msg = "pacote ou classe não encontrados no Kotlin da ponte"
        raise ValueError(msg)
    metodos = EXTERNA.findall(fonte)
    if not metodos:
        msg = "nenhuma external fun no Kotlin da ponte"
        raise ValueError(msg)
    return pacote.group(1), classe.group(1), metodos


def simbolos_esperados(pacote: str, classe: str, metodos: list[str]) -> list[str]:
    """Os símbolos `Java_…` que a JVM procura para cada método nativo."""
    return [f"Java_{mangle(pacote)}_{mangle(classe)}_{mangle(m)}" for m in metodos]


def simbolos_do_nm(saida: str) -> set[str]:
    """Os símbolos definidos e exportados da saída do `llvm-nm -D --defined-only`."""
    nomes = set()
    for linha in saida.splitlines():
        partes = linha.split()
        if len(partes) >= COLUNAS_DO_NM and partes[-2] in {"T", "t", "W"}:
            nomes.add(partes[-1])
    return nomes


def faltando_no_dex(saida: str, pacote: str, classe: str, metodos: list[str]) -> list[str]:
    """O que o R8 renomeou ou removeu: a classe e cada método nativo pelo nome no dex.

    O `apkanalyzer dex packages` separa os campos por tabulação, em linhas como `C r 1 2 120 br.com.x.EclumeCore` e
    `M r 0 1 10 br.com.x.EclumeCore java.lang.String acao(java.lang.String)`.
    """
    completa = f"{pacote}.{classe}"
    linhas = [linha.split() for linha in saida.splitlines()]
    faltam = []
    if not any(campos[:1] == ["C"] and campos[-1] == completa for campos in linhas):
        faltam.append(completa)
    faltam.extend(
        f"{completa}.{metodo}"
        for metodo in metodos
        if not any(
            campos[:1] == ["M"] and completa in campos and any(c.startswith(f"{metodo}(") for c in campos)
            for campos in linhas
        )
    )
    return faltam


def conferir(fonte: str, nm: str, dex: str | None) -> list[str]:
    """Os problemas encontrados (vazio: a ponte confere)."""
    pacote, classe, metodos = ler_kotlin(fonte)
    exportados = simbolos_do_nm(nm)
    problemas = [
        f"símbolo ausente na .so: {s}" for s in simbolos_esperados(pacote, classe, metodos) if s not in exportados
    ]
    if dex is not None:
        problemas += [f"ausente no dex (R8): {f}" for f in faltando_no_dex(dex, pacote, classe, metodos)]
    return problemas


def main(argv: list[str] | None = None) -> int:
    """Confere a ponte e devolve o código de saída (1 com problema)."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--kotlin", type=Path, required=True, help="o EclumeCore.kt")
    parser.add_argument("--nm", type=Path, required=True, help="a saída do llvm-nm -D --defined-only da .so")
    parser.add_argument("--dex", type=Path, help="a saída do apkanalyzer dex packages do APK")
    args = parser.parse_args(argv)
    dex = args.dex.read_text(encoding="utf-8") if args.dex else None
    problemas = conferir(args.kotlin.read_text(encoding="utf-8"), args.nm.read_text(encoding="utf-8"), dex)
    for problema in problemas:
        sys.stderr.write(f"{problema}\n")
    if problemas:
        return 1
    sys.stderr.write("ponte JNI confere: símbolos na .so e EclumeCore no dex\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
