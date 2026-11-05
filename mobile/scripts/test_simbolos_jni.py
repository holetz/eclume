# ruff: noqa: INP001, S101  # testes soltos do script do gate; mobile/ não é pacote Python
"""Testes do `simbolos_jni.py`: o mangling JNI e a conferência da .so e do dex."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("simbolos_jni", Path(__file__).with_name("simbolos_jni.py"))
assert _spec is not None
assert _spec.loader is not None
simbolos_jni = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(simbolos_jni)

KOTLIN = """package io.github.holetz.eclume.movel.gravador

object EclumeCore {
    init {
        System.loadLibrary("eclume_mobile_lib")
    }

    @JvmStatic
    external fun action(name: String): String

    @JvmStatic
    external fun syncPending(base: String): String

    fun naoNativa(): Int = 1
}
"""
PREFIXO = "Java_io_github_holetz_eclume_movel_gravador_EclumeCore_"
NM = f"""0000000000123456 T {PREFIXO}action
0000000000123999 T {PREFIXO}syncPending
0000000000200000 T JNI_OnLoad
"""
# Formato real do apkanalyzer: tipo e estado separados por espaço, o resto por tabulação.
DEX = """P d 3\t3\t300\tio.github.holetz.eclume.movel.gravador
C d 1\t2\t120\tio.github.holetz.eclume.movel.gravador.EclumeCore
M d 0\t1\t10\tio.github.holetz.eclume.movel.gravador.EclumeCore java.lang.String action(java.lang.String)
M d 0\t1\t10\tio.github.holetz.eclume.movel.gravador.EclumeCore java.lang.String syncPending(java.lang.String)
"""


def test_mangling_jni() -> None:
    """O `_` vira `_1` e o `.` vira `_`."""
    assert simbolos_jni.mangle("io.github.holetz") == "io_github_holetz"
    assert simbolos_jni.mangle("sync_pendentes") == "sync_1pendentes"


def test_le_pacote_classe_e_so_as_external_fun() -> None:
    """Só as `external fun` entram, com o pacote e a classe."""
    assert simbolos_jni.ler_kotlin(KOTLIN) == (
        "io.github.holetz.eclume.movel.gravador",
        "EclumeCore",
        ["action", "syncPending"],
    )


def test_ponte_que_confere() -> None:
    """Símbolos na .so e a classe no dex: nada a dizer."""
    assert simbolos_jni.conferir(KOTLIN, NM, DEX) == []


def test_funcao_nova_sem_simbolo_e_pacote_renomeado() -> None:
    """Uma função nova sem Rust e o renome da #17 aparecem."""
    nova = KOTLIN.replace("fun naoNativa", "external fun network(wifi: Boolean): String\n\n    fun naoNativa")
    assert simbolos_jni.conferir(nova, NM, None) == [f"símbolo ausente na .so: {PREFIXO}network"]
    renomeado = KOTLIN.replace("io.github.holetz.eclume.movel", "br.com.eclume.movel")
    novo = "Java_br_com_eclume_movel_gravador_EclumeCore_"
    assert simbolos_jni.conferir(renomeado, NM, None) == [
        f"símbolo ausente na .so: {novo}action",
        f"símbolo ausente na .so: {novo}syncPending",
    ]


def test_r8_que_renomeia_a_classe_ou_tira_um_metodo() -> None:
    """O R8 sem a regra -keep aparece pelo dex."""
    sem_metodo = "\n".join(linha for linha in DEX.splitlines() if "syncPending" not in linha)
    assert simbolos_jni.conferir(KOTLIN, NM, sem_metodo) == [
        "ausente no dex (R8): io.github.holetz.eclume.movel.gravador.EclumeCore.syncPending"
    ]
    renomeada = DEX.replace("gravador.EclumeCore", "gravador.a")
    classe = "io.github.holetz.eclume.movel.gravador.EclumeCore"
    assert simbolos_jni.conferir(KOTLIN, NM, renomeada) == [
        f"ausente no dex (R8): {classe}",
        f"ausente no dex (R8): {classe}.action",
        f"ausente no dex (R8): {classe}.syncPending",
    ]


def test_simbolo_so_importado_nao_conta() -> None:
    """Um símbolo indefinido (`U`) não vale."""
    importado = f"                 U {PREFIXO}action\n0000000000123999 T {PREFIXO}syncPending\n"
    assert simbolos_jni.conferir(KOTLIN, importado, None) == [f"símbolo ausente na .so: {PREFIXO}action"]


def test_kotlin_sem_ponte_e_erro() -> None:
    """Sem `external fun`, o Kotlin lido não é a ponte."""
    with pytest.raises(ValueError, match="external fun"):
        simbolos_jni.ler_kotlin("package x\nobject Y {}\n")


def test_main_devolve_1_com_problema(tmp_path: Path) -> None:
    """O código de saída que o shell do pilar lê."""
    kotlin = tmp_path / "EclumeCore.kt"
    kotlin.write_text(KOTLIN, encoding="utf-8")
    nm = tmp_path / "nm.txt"
    nm.write_text(NM, encoding="utf-8")
    assert simbolos_jni.main(["--kotlin", str(kotlin), "--nm", str(nm)]) == 0
    nm.write_text("", encoding="utf-8")
    assert simbolos_jni.main(["--kotlin", str(kotlin), "--nm", str(nm)]) == 1
