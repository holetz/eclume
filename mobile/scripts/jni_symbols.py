# ruff: noqa: INP001  # loose script, run by the gate's android pillar; mobile/ is not a Python package
"""Check the JNI bridge of the eclume mobile app in the release APK.

Each `external fun` of `EclumeCore.kt` needs a `Java_<package>_<class>_<method>` symbol in the
APK's `libeclume_mobile_lib.so`, and R8 must keep the class and the methods by name in the dex
(the `-keep` rule of `consumer-rules.pro`). A package rename (holetz/eclume#17) or a new function
that exists on one side only shows up here, on the gate, instead of an `UnsatisfiedLinkError` on
the device.

Usage (the pillar shell extracts the `.so` from the APK and runs the NDK and SDK tools):
    python3 mobile/scripts/jni_symbols.py --kotlin <EclumeCore.kt> --nm <llvm-nm -D output> \
        [--dex <apkanalyzer dex packages output>]
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

PACKAGE = re.compile(r"^\s*package\s+([\w.]+)", re.MULTILINE)
CLASS = re.compile(r"^\s*(?:object|class)\s+(\w+)", re.MULTILINE)
EXTERNAL = re.compile(r"\bexternal\s+fun\s+(\w+)\s*\(")
# An `llvm-nm` line with a defined symbol has at least the type and the name.
NM_COLUMNS = 2


def mangle(part: str) -> str:
    """The JNI mangling of a name: `_` becomes `_1` and `.` becomes `_` (ASCII names, as the app's)."""
    return part.replace("_", "_1").replace(".", "_")


def read_kotlin(source: str) -> tuple[str, str, list[str]]:
    """The package, the class and the `external fun`s of a Kotlin file."""
    package = PACKAGE.search(source)
    klass = CLASS.search(source)
    if not package or not klass:
        msg = "package or class not found in the bridge Kotlin"
        raise ValueError(msg)
    methods = EXTERNAL.findall(source)
    if not methods:
        msg = "no external fun in the bridge Kotlin"
        raise ValueError(msg)
    return package.group(1), klass.group(1), methods


def expected_symbols(package: str, klass: str, methods: list[str]) -> list[str]:
    """The `Java_…` symbols the JVM looks up for each native method."""
    return [f"Java_{mangle(package)}_{mangle(klass)}_{mangle(m)}" for m in methods]


def nm_symbols(output: str) -> set[str]:
    """The defined and exported symbols of the `llvm-nm -D --defined-only` output."""
    names = set()
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= NM_COLUMNS and parts[-2] in {"T", "t", "W"}:
            names.add(parts[-1])
    return names


def missing_from_dex(output: str, package: str, klass: str, methods: list[str]) -> list[str]:
    """What R8 renamed or removed: the class and each native method by name in the dex.

    `apkanalyzer dex packages` separates the fields by tabs, in lines such as `C r 1 2 120 br.com.x.EclumeCore` and
    `M r 0 1 10 br.com.x.EclumeCore java.lang.String action(java.lang.String)`.
    """
    full = f"{package}.{klass}"
    lines = [line.split() for line in output.splitlines()]
    missing = []
    if not any(fields[:1] == ["C"] and fields[-1] == full for fields in lines):
        missing.append(full)
    missing.extend(
        f"{full}.{method}"
        for method in methods
        if not any(
            fields[:1] == ["M"] and full in fields and any(f.startswith(f"{method}(") for f in fields)
            for fields in lines
        )
    )
    return missing


def check(source: str, nm: str, dex: str | None) -> list[str]:
    """The problems found (empty: the bridge checks out)."""
    package, klass, methods = read_kotlin(source)
    exported = nm_symbols(nm)
    problems = [
        f"symbol missing from the .so: {s}" for s in expected_symbols(package, klass, methods) if s not in exported
    ]
    if dex is not None:
        problems += [f"missing from the dex (R8): {f}" for f in missing_from_dex(dex, package, klass, methods)]
    return problems


def main(argv: list[str] | None = None) -> int:
    """Check the bridge and return the exit code (1 on a problem)."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--kotlin", type=Path, required=True, help="the EclumeCore.kt")
    parser.add_argument("--nm", type=Path, required=True, help="the .so's llvm-nm -D --defined-only output")
    parser.add_argument("--dex", type=Path, help="the APK's apkanalyzer dex packages output")
    args = parser.parse_args(argv)
    dex = args.dex.read_text(encoding="utf-8") if args.dex else None
    problems = check(args.kotlin.read_text(encoding="utf-8"), args.nm.read_text(encoding="utf-8"), dex)
    for problem in problems:
        sys.stderr.write(f"{problem}\n")
    if problems:
        return 1
    sys.stderr.write("JNI bridge checks out: symbols in the .so and EclumeCore in the dex\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
