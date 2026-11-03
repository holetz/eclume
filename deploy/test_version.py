# ruff: noqa: INP001, S101  # loose tests of the deploy scripts; deploy/ is not a Python package
"""Tests of `version.py`: the three lines move together, each version has a section and each migration an entry."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("version", Path(__file__).with_name("version.py"))
assert _spec is not None
assert _spec.loader is not None
version = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(version)

ROOT = Path(__file__).resolve().parent.parent

PRODUCT_CHANGELOG = """# eclume changelog

## [Unreleased]

## [0.1.0] - 2026-09-30

### Added

- First version.

### For those who host it

- Migrations: `001_nucleo`.
"""


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _cargo_lock(packages: dict[str, str]) -> str:
    external = '[[package]]\nname = "serde"\nversion = "0.4.0"\nsource = "registry+https://github.com/x"\n\n'
    local = "".join(f'[[package]]\nname = "{n}"\nversion = "{v}"\ndependencies = []\n\n' for n, v in packages.items())
    return "version = 4\n\n" + external + local


def tree(root: Path) -> Path:
    """A minimal tree with the manifests of the three lines, up to date."""
    for rel, name in version.PYPROJECTS.items():
        _write(root, rel, f'[project]\nname = "{name}"\nversion = "0.1.0"\n\n[tool.x]\nversion = "9.9.9"\n')
    for rel in version.INITS:
        _write(root, rel, 'from importlib.metadata import version\n\n__version__ = version("x")\n')
    _write(root, "web/package.json", '{\n  "name": "eclume-web",\n  "version": "0.1.0"\n}\n')
    _write(
        root,
        "web/package-lock.json",
        '{\n  "name": "eclume-web",\n  "version": "0.1.0",\n  "packages": {\n'
        '    "": {\n      "name": "eclume-web",\n      "version": "0.1.0"\n    },\n'
        '    "node_modules/a": {\n      "version": "0.1.0"\n    }\n  }\n}\n',
    )
    uv = "version = 1\n\n"
    for name, folder in zip(version.PYPROJECTS.values(), ("server", "engines", "worker-gpu"), strict=True):
        uv += f'[[package]]\nname = "{name}"\nversion = "0.1.0"\nsource = {{ editable = "{folder}" }}\n\n'
    _write(root, "uv.lock", uv)
    for folder, v, crates in (
        ("desktop", "0.4.0", ["eclume-desktop", "eclume-sync"]),
        ("mobile", "0.1.0", ["eclume-mobile"]),
    ):
        members = ", ".join(f'"m{i}"' for i in range(len(crates)))
        _write(
            root,
            f"{folder}/Cargo.toml",
            f'[workspace]\nmembers = [{members}]\n\n[workspace.package]\nversion = "{v}"\n',
        )
        for i, crate in enumerate(crates):
            _write(root, f"{folder}/m{i}/Cargo.toml", f'[package]\nname = "{crate}"\nversion.workspace = true\n')
        _write(root, f"{folder}/src-tauri/tauri.conf.json", f'{{\n  "productName": "eclume",\n  "version": "{v}"\n}}\n')
    _write(root, "desktop/Cargo.lock", _cargo_lock({"eclume-desktop": "0.4.0", "eclume-sync": "0.4.0"}))
    _write(root, "mobile/Cargo.lock", _cargo_lock({"eclume-mobile": "0.1.0", "eclume-sync": "0.4.0"}))
    _write(root, f"{version.MIGRATIONS}/001_nucleo.sql", "select 1;\n")
    _write(root, "CHANGELOG.md", PRODUCT_CHANGELOG)
    _write(root, "desktop/CHANGELOG.md", "# Desktop\n\n## [Unreleased]\n\n## [0.4.0] - 2026-09-30\n\n- Tray.\n")
    _write(root, "mobile/CHANGELOG.md", "# Phone\n\n## [Unreleased]\n\n## [0.1.0] - 2026-09-27\n\n- Recorder.\n")
    return root


def test_up_to_date_tree_has_no_problems(tmp_path: Path) -> None:
    """The tree with everything tied passes and each line states its own version."""
    root = tree(tmp_path)
    assert version.check(root) == []
    assert [version.current(root, line) for line in version.LINES] == ["0.1.0", "0.4.0", "0.1.0"]


def test_set_product_moves_every_field_and_only_those(tmp_path: Path) -> None:
    """`set` on the product moves the manifests and the locks, without touching any other `version`."""
    root = tree(tmp_path)
    touched = version.set_version(root, "product", "0.2.0")
    assert set(touched) == {*version.PYPROJECTS, "web/package.json", "web/package-lock.json", "uv.lock"}
    assert {v for _, v in version._values(root, "product")} == {"0.2.0"}  # noqa: SLF001
    assert 'version = "9.9.9"' in (root / "server/pyproject.toml").read_text(encoding="utf-8")
    assert '"node_modules/a": {\n      "version": "0.1.0"' in (root / "web/package-lock.json").read_text(
        encoding="utf-8"
    )
    assert version.check(root) == ["CHANGELOG.md: missing the [0.2.0] section of the current product version"]


def test_set_desktop_reaches_its_crates_in_both_locks(tmp_path: Path) -> None:
    """The desktop crates move in the phone's lock too, which uses them by path."""
    root = tree(tmp_path)
    version.set_version(root, "desktop", "0.5.0")
    mobile = (root / "mobile/Cargo.lock").read_text(encoding="utf-8")
    assert 'name = "eclume-sync"\nversion = "0.5.0"' in mobile
    assert 'name = "eclume-mobile"\nversion = "0.1.0"' in mobile
    assert 'name = "serde"\nversion = "0.4.0"' in (root / "desktop/Cargo.lock").read_text(encoding="utf-8")
    assert version.current(root, "mobile") == "0.1.0"


def test_set_refuses_a_version_outside_semver(tmp_path: Path) -> None:
    """Only `X.Y.Z` gets in."""
    with pytest.raises(ValueError, match="SemVer"):
        version.set_version(tree(tmp_path), "product", "0.2")


def test_check_flags_a_diverging_field(tmp_path: Path) -> None:
    """A field out of step flags the line, and so does the new version without a section."""
    root = tree(tmp_path)
    tauri = root / "mobile/src-tauri/tauri.conf.json"
    tauri.write_text(tauri.read_text(encoding="utf-8").replace("0.1.0", "0.1.1"), encoding="utf-8")
    divergence, no_section = version.check(root)
    assert divergence.startswith("mobile: diverging versions")
    assert no_section == "mobile/CHANGELOG.md: missing the [0.1.1] section of the current mobile version"


def test_check_flags_a_literal_version(tmp_path: Path) -> None:
    """A `__version__` that goes back to literal is flagged."""
    root = tree(tmp_path)
    _write(root, version.INITS[1], '__version__ = "0.1.0"\n')
    assert version.check(root) == [f"{version.INITS[1]}: literal __version__; read it from importlib.metadata.version"]


def test_check_flags_a_migration_without_an_entry(tmp_path: Path) -> None:
    """A migration that no product entry mentions is flagged."""
    root = tree(tmp_path)
    _write(root, f"{version.MIGRATIONS}/002_agentes.sql", "select 1;\n")
    assert version.check(root) == ["CHANGELOG.md: no entry mentions the migration 002_agentes"]


def test_check_needs_unreleased_on_top(tmp_path: Path) -> None:
    """The CHANGELOG opens with `[Unreleased]`."""
    root = tree(tmp_path)
    _write(root, "CHANGELOG.md", PRODUCT_CHANGELOG.replace("## [Unreleased]\n\n", ""))
    assert version.check(root) == ["CHANGELOG.md: the first section must be [Unreleased]"]


def test_check_refuses_the_old_portuguese_heading(tmp_path: Path) -> None:
    """The pre-rename `[Não lançado]` heading is no longer the unreleased section."""
    root = tree(tmp_path)
    _write(root, "CHANGELOG.md", PRODUCT_CHANGELOG.replace("[Unreleased]", "[Não lançado]"))
    assert "CHANGELOG.md: the first section must be [Unreleased]" in version.check(root)


def test_notes_return_the_section_body(tmp_path: Path) -> None:
    """The notes are the section body; `Unreleased` may be empty."""
    root = tree(tmp_path)
    assert version.notes(root, "desktop", "0.4.0") == "- Tray."
    assert version.notes(root, "product", version.UNRELEASED) == ""
    with pytest.raises(ValueError, match=r"has no \[0\.9\.9\] section"):
        version.notes(root, "desktop", "0.9.9")


def test_notes_refuse_an_empty_section(tmp_path: Path) -> None:
    """A numbered version without a body does not become release notes."""
    root = tree(tmp_path)
    _write(root, "mobile/CHANGELOG.md", "# Phone\n\n## [Unreleased]\n\n## [0.1.0] - 2026-09-27\n")
    with pytest.raises(ValueError, match="empty"):
        version.notes(root, "mobile", "0.1.0")


def test_main_check_and_notes(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """The command line: notes on stdout, divergence on stderr with exit 1."""
    root = tree(tmp_path)
    assert version.main(["--root", str(root), "notes", "product", "0.1.0"]) == 0
    assert capsys.readouterr().out.startswith("### Added")
    assert version.main(["--root", str(root), "set", "mobile", "0.2.0"]) == 0
    capsys.readouterr()
    assert version.main(["--root", str(root), "check"]) == 1
    assert "missing the [0.2.0] section" in capsys.readouterr().err


def test_the_repository_is_up_to_date() -> None:
    """`check` over the real tree: manifests, CHANGELOGs and migrations tied together."""
    assert version.check(ROOT) == []
