# ruff: noqa: INP001, S101  # loose tests of the deploy scripts; deploy/ is not a Python package
"""Tests of `docs_check.py`: each problem proved in a fake repository."""

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


def repo(tmp_path: Path, files: dict[str, str]) -> Path:
    """A fake repository with the given files."""
    for name, text in files.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return tmp_path


@pytest.fixture(autouse=True)
def no_exceptions(monkeypatch: pytest.MonkeyPatch) -> None:
    """The tests declare their own exceptions; the repository's do not apply here."""
    monkeypatch.setattr(docs_check, "EXCEPTIONS", ())


@pytest.mark.parametrize(
    ("heading", "expected"),
    [
        ("Gravação, data, natureza e marcadores", "gravação-data-natureza-e-marcadores"),
        ("CI and gate — `deploy/pillars.sh` and `deploy/gate.sh`", "ci-and-gate--deploypillarssh-and-deploygatesh"),
        ("Fixação da CA pelos apps", "fixação-da-ca-pelos-apps"),
        ("Ver [o contrato](contrato.md) v1", "ver-o-contrato-v1"),
    ],
)
def test_github_style_slug(heading: str, expected: str) -> None:
    """Lowercase, accents kept, punctuation dropped, a space becomes a hyphen; backticks and links become text."""
    assert docs_check.slug(heading) == expected


def test_repeated_heading_gets_a_suffix() -> None:
    """The second equal heading becomes `-1`, as on GitHub."""
    assert docs_check.anchors("# Usage\n\n## Usage\n") == {"usage", "usage-1"}


def test_link_to_a_file_or_anchor_that_does_not_exist(tmp_path: Path) -> None:
    """A relative, absolute or anchor-only link is checked; an external one is not."""
    root = repo(
        tmp_path,
        {
            "docs/a.md": "# A\n\n## Good part\n",
            "docs/b.md": (
                "# B\n\n[ok](a.md#good-part) [abs](/docs/a.md) [web](https://x.y/z)\n"
                "[gone](c.md)\n[anchor](a.md#bad-part)\n[here](#b) [not here](#c)\n"
            ),
        },
    )
    assert docs_check.check(root) == [
        "docs/b.md:4: link to c.md, which does not exist",
        "docs/b.md:5: anchor #bad-part does not exist in docs/a.md",
        "docs/b.md:6: anchor #c does not exist in docs/b.md",
    ]


def test_link_in_code_does_not_count(tmp_path: Path) -> None:
    """A link inside backticks or a code block is an example, not a link."""
    root = repo(tmp_path, {"docs/a.md": "# A\n\n`[x](none.md)`\n\n```\n[y](none.md)\n```\n"})
    assert docs_check.check(root) == []


def test_backticked_path_that_does_not_exist(tmp_path: Path) -> None:
    """A path starting with a top-level folder is checked (`:line` ignored); a wildcard, command or variable is not."""
    root = repo(
        tmp_path,
        {
            "deploy/gate.sh": "",
            "docs/a.md": (
                "# A\n\n`deploy/gate.sh:12` `deploy/gate.sh` `deploy/gone.sh` `deploy/*.sh`\n"
                "`bash deploy/gone.sh` `deploy/<name>.yml` `$HOME/x` `other/thing.txt`\n"
            ),
        },
    )
    assert docs_check.check(root) == ["docs/a.md:3: path `deploy/gone.sh` does not exist"]


def test_exception_covers_the_path_and_a_stale_one_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """An exception applies only in its own file; one that is no longer used becomes a problem."""
    root = repo(tmp_path, {"deploy/x.sh": "", "docs/a.md": "# A\n\n`deploy/.env`\n"})
    monkeypatch.setattr(
        docs_check,
        "EXCEPTIONS",
        (
            docs_check.PathException("docs/a.md", "deploy/.env", "outside git"),
            docs_check.PathException("docs/a.md", "deploy/old", "no longer cited"),
        ),
    )
    assert docs_check.check(root) == [
        "stale exception: `deploy/old` in docs/a.md (no longer cited); remove it from EXCEPTIONS",
    ]


def test_glossary_in_order_ignoring_case_and_accents() -> None:
    """The order ignores case and accents; the entry out of order is pointed out."""
    text = (
        "# Glossary\n\n## Terms\n\n- **Ágora** — a\n- [bank](x.md) — b\n- **Canto** — c\n"
        "- **ball** — d\n\n## Other\n\n- **Zeta**\n- **alpha**\n"
    )
    assert docs_check.glossary_problems(text) == [
        "docs/glossary.md:8: 'ball' out of alphabetical order (after 'Canto')",
    ]


def test_quenching_at_the_same_ref_in_the_gate_and_in_ci() -> None:
    """The `cq` of the `docs` pillar is the same holetz/quenching commit in the gate image and in the CI job."""
    root = Path(__file__).resolve().parent.parent
    dockerfile = (root / "deploy/gate.Dockerfile").read_text(encoding="utf-8")
    ci = yaml.safe_load((root / ".github/workflows/ci.yml").read_text(encoding="utf-8"))
    gate = re.search(r"^ARG QUENCHING_SHA=([0-9a-f]{40})$", dockerfile, re.MULTILINE)
    assert gate is not None
    refs = [
        step["with"]["ref"]
        for step in ci["jobs"]["docs"]["steps"]
        if (step.get("with") or {}).get("repository") == "holetz/quenching"
    ]
    assert refs == [gate[1]]
    assert any("bash deploy/pillars.sh docs" in str(step.get("run", "")) for step in ci["jobs"]["docs"]["steps"])
