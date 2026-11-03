# ruff: noqa: INP001, S101, S603, S607, D103  # loose tests of the deploy scripts; deploy/ is not a Python package
"""Tests of `skips.py` and of the list `pillars.sh` picks: an unlisted skip fails, a listed one passes."""

from __future__ import annotations

import importlib.util
import os
import re
import subprocess
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("skips", Path(__file__).with_name("skips.py"))
assert _spec is not None
assert _spec.loader is not None
skips = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(skips)

ROOT = Path(__file__).resolve().parent
LIST = "# c\nworker-gpu/tests/test_a.py::test_one | reason\n"


def report(*cases: tuple[str, str, bool]) -> str:
    skip = '<skipped message="x"/>'
    items = "".join(f'<testcase classname="{c}" name="{n}">{skip if s else ""}</testcase>' for c, n, s in cases)
    return f"<testsuites><testsuite>{items}</testsuite></testsuites>"


def problems(xml: str, listing: str = LIST) -> list[str]:
    return skips.compare(skips.read_skips(xml), skips.read_list(listing))


def test_listed_skip_passes() -> None:
    assert problems(report(("worker-gpu.tests.test_a", "test_one", True), ("x.test_b", "test_ok", False))) == []


def test_unlisted_skip_fails() -> None:
    out = problems(report(("worker-gpu.tests.test_a", "test_one", True), ("server.tests.test_b", "test_new", True)))
    assert len(out) == 1
    assert "test_new" in out[0]


def test_listed_skip_that_did_not_happen_fails() -> None:
    out = problems(report(("worker-gpu.tests.test_a", "test_one", False)))
    assert len(out) == 1
    assert "stale" in out[0]


def test_repo_lists_differ_only_in_the_real_claude() -> None:
    ci = skips.read_list((ROOT / "expected-skips-ci.txt").read_text())
    gate = skips.read_list((ROOT / "expected-skips-gate.txt").read_text())
    assert ci - gate == {c for c in ci if "test_agents_real" in c}
    assert gate <= ci


def _skips_list(env: dict[str, str]) -> str:
    text = (ROOT / "pillars.sh").read_text(encoding="utf-8")
    found = re.search(r"^skips_list\(\) \{\n.*?^\}\n", text, re.DOTALL | re.MULTILINE)
    assert found
    return subprocess.run(
        ["bash", "-c", found.group(0) + "skips_list\n"],
        env={"PATH": os.environ["PATH"], **env},
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


@pytest.mark.parametrize(
    ("env", "listing"),
    [
        ({}, "ci"),
        ({"ECLUME_SKIPS": "gate"}, "gate"),
        ({"ECLUME_PULOS": "gate"}, "gate"),  # the deprecated name still works
        ({"ECLUME_SKIPS": "gpu-e2e", "ECLUME_PULOS": "gate"}, "gpu-e2e"),  # the new name wins
    ],
)
def test_skips_list_reads_the_new_name_then_the_old_one(env: dict[str, str], listing: str) -> None:
    path = _skips_list(env)
    assert path == f"deploy/expected-skips-{listing}.txt"
    assert (ROOT.parent / path).is_file()
