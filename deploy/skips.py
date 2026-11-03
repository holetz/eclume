# ruff: noqa: INP001, T201, S314  # loose script, called by the pillar and by the test; deploy/ is not a Python package
"""Checks the pytest skips against the versioned list of expected skips.

Usage: python3 deploy/skips.py <junit.xml> <list.txt>

Each list line is `<file>::<test> | <reason>` (`#` starts a comment). Fails (exit 1) on a skip missing
from the list and on a listed skip that no longer happens, so the list does not go stale.
Contract: docs/standards/code/monorepo.md.
"""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ARGS = 3  # the script, the report and the list


def read_list(text: str) -> set[str]:
    """The `<file>::<test>` keys of the list, without comments or blank lines."""
    keys: set[str] = set()
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            keys.add(line.split("|", 1)[0].strip())
    return keys


def read_skips(xml: str) -> dict[str, str]:
    """The skips of the junit report: key `<file>::<test>` and the reason."""
    skips: dict[str, str] = {}
    for case in ET.fromstring(xml).iter("testcase"):
        skip = case.find("skipped")
        if skip is None:
            continue
        module = (case.get("classname") or "").replace(".", "/")
        skips[f"{module}::{case.get('name')}"] = skip.get("message") or ""
    return skips


def compare(skips: dict[str, str], expected: set[str]) -> list[str]:
    """The problems: a skip with no entry and an entry whose skip did not happen."""
    problems = [
        f"undocumented skip: {key} ({reason})" for key, reason in sorted(skips.items()) if _outside(key, expected)
    ]
    problems += [
        f"expected skip that did not happen (stale list): {e}" for e in sorted(expected) if not _happened(e, skips)
    ]
    return problems


def _matches(expected: str, key: str) -> bool:
    # `file::test` matches the key's suffix (junit carries the module's full path).
    module, _, test = expected.partition("::")
    key_module, _, key_test = key.partition("::")
    return test == key_test and key_module.endswith(module.removesuffix(".py"))


def _outside(key: str, expected: set[str]) -> bool:
    return not any(_matches(e, key) for e in expected)


def _happened(expected: str, skips: dict[str, str]) -> bool:
    return any(_matches(expected, k) for k in skips)


def main(argv: list[str]) -> int:
    """Compares the report with the list and returns the process exit code."""
    if len(argv) != ARGS:
        print(__doc__)
        return 2
    problems = compare(read_skips(Path(argv[1]).read_text()), read_list(Path(argv[2]).read_text()))
    for p in problems:
        print(f"ERROR: {p}")
    if not problems:
        print("pytest skips: only the documented ones.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
