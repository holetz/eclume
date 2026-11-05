# ruff: noqa: INP001, S101  # loose tests of the gate script; mobile/ is not a Python package
"""Tests of `jni_symbols.py`: the JNI mangling and the check of the .so and the dex."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("jni_symbols", Path(__file__).with_name("jni_symbols.py"))
assert _spec is not None
assert _spec.loader is not None
jni_symbols = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(jni_symbols)

KOTLIN = """package io.github.holetz.eclume.movel.gravador

object EclumeCore {
    init {
        System.loadLibrary("eclume_mobile_lib")
    }

    @JvmStatic
    external fun action(name: String): String

    @JvmStatic
    external fun syncPending(base: String): String

    fun notNative(): Int = 1
}
"""
PREFIX = "Java_io_github_holetz_eclume_movel_gravador_EclumeCore_"
NM = f"""0000000000123456 T {PREFIX}action
0000000000123999 T {PREFIX}syncPending
0000000000200000 T JNI_OnLoad
"""
# The real apkanalyzer format: type and state separated by a space, the rest by tabs.
DEX = """P d 3\t3\t300\tio.github.holetz.eclume.movel.gravador
C d 1\t2\t120\tio.github.holetz.eclume.movel.gravador.EclumeCore
M d 0\t1\t10\tio.github.holetz.eclume.movel.gravador.EclumeCore java.lang.String action(java.lang.String)
M d 0\t1\t10\tio.github.holetz.eclume.movel.gravador.EclumeCore java.lang.String syncPending(java.lang.String)
"""


def test_jni_mangling() -> None:
    """`_` becomes `_1` and `.` becomes `_`."""
    assert jni_symbols.mangle("io.github.holetz") == "io_github_holetz"
    assert jni_symbols.mangle("sync_pending") == "sync_1pending"


def test_reads_package_class_and_only_the_external_funs() -> None:
    """Only the `external fun`s count, with the package and the class."""
    assert jni_symbols.read_kotlin(KOTLIN) == (
        "io.github.holetz.eclume.movel.gravador",
        "EclumeCore",
        ["action", "syncPending"],
    )


def test_bridge_that_checks_out() -> None:
    """Symbols in the .so and the class in the dex: nothing to report."""
    assert jni_symbols.check(KOTLIN, NM, DEX) == []


def test_new_function_without_symbol_and_renamed_package() -> None:
    """A new function without Rust and the #17 rename show up."""
    new = KOTLIN.replace("fun notNative", "external fun network(wifi: Boolean): String\n\n    fun notNative")
    assert jni_symbols.check(new, NM, None) == [f"symbol missing from the .so: {PREFIX}network"]
    renamed = KOTLIN.replace("io.github.holetz.eclume.movel", "br.com.eclume.movel")
    prefix = "Java_br_com_eclume_movel_gravador_EclumeCore_"
    assert jni_symbols.check(renamed, NM, None) == [
        f"symbol missing from the .so: {prefix}action",
        f"symbol missing from the .so: {prefix}syncPending",
    ]


def test_r8_that_renames_the_class_or_drops_a_method() -> None:
    """R8 without the -keep rule shows up through the dex."""
    no_method = "\n".join(line for line in DEX.splitlines() if "syncPending" not in line)
    assert jni_symbols.check(KOTLIN, NM, no_method) == [
        "missing from the dex (R8): io.github.holetz.eclume.movel.gravador.EclumeCore.syncPending"
    ]
    renamed = DEX.replace("gravador.EclumeCore", "gravador.a")
    klass = "io.github.holetz.eclume.movel.gravador.EclumeCore"
    assert jni_symbols.check(KOTLIN, NM, renamed) == [
        f"missing from the dex (R8): {klass}",
        f"missing from the dex (R8): {klass}.action",
        f"missing from the dex (R8): {klass}.syncPending",
    ]


def test_imported_only_symbol_does_not_count() -> None:
    """An undefined symbol (`U`) does not count."""
    imported = f"                 U {PREFIX}action\n0000000000123999 T {PREFIX}syncPending\n"
    assert jni_symbols.check(KOTLIN, imported, None) == [f"symbol missing from the .so: {PREFIX}action"]


def test_kotlin_without_bridge_is_an_error() -> None:
    """Without an `external fun`, the Kotlin read is not the bridge."""
    with pytest.raises(ValueError, match="external fun"):
        jni_symbols.read_kotlin("package x\nobject Y {}\n")


def test_main_returns_1_on_a_problem(tmp_path: Path) -> None:
    """The exit code the pillar shell reads."""
    kotlin = tmp_path / "EclumeCore.kt"
    kotlin.write_text(KOTLIN, encoding="utf-8")
    nm = tmp_path / "nm.txt"
    nm.write_text(NM, encoding="utf-8")
    assert jni_symbols.main(["--kotlin", str(kotlin), "--nm", str(nm)]) == 0
    nm.write_text("", encoding="utf-8")
    assert jni_symbols.main(["--kotlin", str(kotlin), "--nm", str(nm)]) == 1
