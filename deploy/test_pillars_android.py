# ruff: noqa: INP001, S101, S603, S607, D103  # loose tests of the deploy scripts; deploy/ is not a Python package
"""Cleanup and guard of the cargo registry `build/` in `pillar_android`: safe with arbitrary names."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

PILLARS = Path(__file__).with_name("pillars.sh")
FUNCTIONS = ("tauri_android_builds", "tauri_android_clean_builds", "tauri_android_intruders")


def function(name: str) -> str:
    text = PILLARS.read_text(encoding="utf-8")
    found = re.search(rf"^{name}\(\) \{{\n.*?^\}}\n", text, re.DOTALL | re.MULTILINE)
    assert found, name
    return found.group(0)


def bash(cargo_home: Path, body: str) -> subprocess.CompletedProcess[bytes]:
    script = "set -euo pipefail\n" + "".join(function(n) for n in FUNCTIONS) + body
    return subprocess.run(
        ["bash", "-c", script],
        env={"CARGO_HOME": str(cargo_home), "PATH": "/usr/bin:/bin"},
        capture_output=True,
        check=False,
    )


def registry(root: Path) -> Path:
    """A fake registry with the real crate and a sibling whose name has an LF, both with `build/`."""
    idx = root / "registry" / "src" / "idx"
    (idx / "tauri-2.12.1" / "mobile" / "android" / "src").mkdir(parents=True)
    (idx / "tauri-2.12.1" / "mobile" / "android" / "src" / "Fonte.kt").write_text("source", encoding="utf-8")
    (idx / "tauri-2.12.1\nx" / "mobile" / "android" / "build").mkdir(parents=True)
    (idx / "tauri-2.9.0" / "mobile" / "android" / "build").mkdir(parents=True)
    return idx


def test_cleanup_with_an_lf_name_deletes_only_the_target(tmp_path: Path) -> None:
    idx = registry(tmp_path)
    r = bash(tmp_path, "tauri_android_clean_builds\n")
    assert r.returncode == 0, r.stderr
    assert (idx / "tauri-2.12.1" / "mobile" / "android" / "src" / "Fonte.kt").is_file()
    assert not (idx / "tauri-2.12.1\nx" / "mobile" / "android" / "build").exists()
    assert not (idx / "tauri-2.9.0" / "mobile" / "android" / "build").exists()
    assert (idx / "tauri-2.9.0" / "mobile" / "android").is_dir()


def test_guard_flags_an_intruder_and_passes_without_one(tmp_path: Path) -> None:
    registry(tmp_path)
    assert bash(tmp_path, "tauri_android_intruders\n").returncode == 1
    assert bash(tmp_path, "tauri_android_clean_builds\ntauri_android_intruders\n").returncode == 0


@pytest.mark.skipif(os.geteuid() == 0, reason="root traverses and lists any directory")
def test_cleanup_and_guard_fail_when_find_cannot_read_the_registry(tmp_path: Path) -> None:
    idx = registry(tmp_path)
    idx.chmod(0o300)
    try:
        assert bash(tmp_path, "tauri_android_clean_builds\n").returncode != 0
        assert bash(tmp_path, "tauri_android_intruders\n").returncode != 0
    finally:
        idx.chmod(0o700)
