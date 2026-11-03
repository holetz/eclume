# ruff: noqa: INP001  # loose script, called by the test, the deploy and the releases; deploy/ is not a Python package
"""eclume versions: the three lines, their manifests and their CHANGELOGs, stdlib only.

Lines (docs/standards/code/versionamento.md):

- `product` — server, GPU worker, engines and web: the three `pyproject.toml`, `web/package.json`,
  `web/package-lock.json` and the members in `uv.lock`; the root `CHANGELOG.md`;
- `desktop` — `desktop/src-tauri/tauri.conf.json`, the `[workspace.package]` of `desktop/Cargo.toml`
  and its crates in the `Cargo.lock` files; `desktop/CHANGELOG.md`;
- `mobile` — the same under `mobile/`; `mobile/CHANGELOG.md`.

Usage:
    python3 deploy/version.py current <line>            # the line's version
    python3 deploy/version.py set <line> <version>      # writes the version into every manifest
    python3 deploy/version.py check                     # exits 1 if anything diverges
    python3 deploy/version.py notes <line> <version>    # the section body (or "Unreleased")
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UNRELEASED = "Unreleased"
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
SECTION = re.compile(r"^## \[(?P<name>[^\]]+)\](?: - (?P<date>\d{4}-\d{2}-\d{2}))?\s*$", re.MULTILINE)
MIGRATIONS = "server/src/eclume_server/db/migrations"
PYPROJECTS = {
    "server/pyproject.toml": "eclume-server",
    "engines/pyproject.toml": "eclume-engines",
    "worker-gpu/pyproject.toml": "eclume-worker",
}
INITS = (
    "server/src/eclume_server/__init__.py",
    "engines/src/eclume_engines/__init__.py",
    "worker-gpu/src/eclume_worker/__init__.py",
)
CARGO_LOCKS = ("desktop/Cargo.lock", "mobile/Cargo.lock")


APPS = {"desktop": "desktop", "mobile": "mobile"}  # line → folder of the Cargo workspace with Tauri
LINES = ("product", *APPS)
CHANGELOGS = {"product": "CHANGELOG.md", "desktop": "desktop/CHANGELOG.md", "mobile": "mobile/CHANGELOG.md"}


def _read(root: Path, rel: str) -> str:
    return (root / rel).read_text(encoding="utf-8")


def _write(root: Path, rel: str, text: str) -> None:
    (root / rel).write_text(text, encoding="utf-8", newline="\n")


# --- version fields: each read and rewritten by expression, without reformatting the file --------

_PYPROJECT = re.compile(r'(?m)^(version = ")([^"]*)(")')
_JSON_VERSION = re.compile(r'(?m)^(  "version": ")([^"]*)(")')
_WORKSPACE = re.compile(r'(?ms)^(\[workspace\.package\]\n(?:(?!\[).*\n)*?version = ")([^"]*)(")')


def _lock_package(name: str) -> re.Pattern[str]:
    """The `version` of a local `[[package]]` by name: in `Cargo.lock`, without `source`; in `uv.lock`, editable."""
    head = rf'(?m)^(\[\[package\]\]\nname = "{re.escape(name)}"\nversion = ")'
    return re.compile(head + r'([^"]*)("\n(?!source = "))')


def _crates(root: Path, folder: str) -> list[str]:
    """The crates of the app workspace that inherit its version (`version.workspace = true`)."""
    members = re.search(r"(?ms)^members = \[(.*?)\]", _read(root, f"{folder}/Cargo.toml"))
    names = []
    for member in re.findall(r'"([^"]+)"', members.group(1) if members else ""):
        manifest = _read(root, f"{folder}/{member}/Cargo.toml")
        name = re.search(r'(?m)^name = "([^"]+)"', manifest)
        if name and re.search(r"(?m)^version\.workspace = true", manifest):
            names.append(name.group(1))
    return names


def _fields(root: Path, line: str) -> list[tuple[str, re.Pattern[str], str]]:
    """The line's fields: (file, expression with the value in group 2, label)."""
    if line == "product":
        fields = [(rel, _PYPROJECT, rel) for rel in PYPROJECTS]
        fields += [(rel, _JSON_VERSION, rel) for rel in ("web/package.json", "web/package-lock.json")]
        web_lock = re.compile(r'(?m)^(    "": \{\n      "name": "eclume-web",\n      "version": ")([^"]*)(")')
        fields.append(("web/package-lock.json", web_lock, 'web/package-lock.json packages[""]'))
        fields += [("uv.lock", _lock_package(name), f"uv.lock {name}") for name in PYPROJECTS.values()]
        return fields
    folder = APPS[line]
    tauri, cargo = f"{folder}/src-tauri/tauri.conf.json", f"{folder}/Cargo.toml"
    fields = [(tauri, _JSON_VERSION, tauri), (cargo, _WORKSPACE, f"{cargo} [workspace.package]")]
    for name in _crates(root, folder):
        for lock in CARGO_LOCKS:
            if _lock_package(name).search(_read(root, lock)):
                fields.append((lock, _lock_package(name), f"{lock} {name}"))
    return fields


def _values(root: Path, line: str) -> list[tuple[str, str | None]]:
    """The value of each of the line's fields (`None` when the field is missing)."""
    values = []
    for rel, pattern, label in _fields(root, line):
        found = pattern.search(_read(root, rel))
        values.append((label, found.group(2) if found else None))
    return values


def current(root: Path, line: str) -> str:
    """The line's version: that of its first field (`server/pyproject.toml` or `tauri.conf.json`)."""
    value = _values(root, line)[0][1]
    if value is None:
        msg = f"no version in {_fields(root, line)[0][2]}"
        raise ValueError(msg)
    return value


def set_version(root: Path, line: str, version: str) -> list[str]:
    """Writes the version into every field of the line and returns the files touched."""
    if not SEMVER.match(version):
        msg = f"version is not SemVer X.Y.Z: {version}"
        raise ValueError(msg)
    touched: list[str] = []
    for rel, pattern, label in _fields(root, line):
        text = _read(root, rel)
        new, n = pattern.subn(lambda m: m.group(1) + version + m.group(3), text, count=1)
        if n == 0:
            msg = f"version field not found: {label}"
            raise ValueError(msg)
        if new != text:
            _write(root, rel, new)
        if rel not in touched:
            touched.append(rel)
    return touched


# --- CHANGELOG -------------------------------------------------------------------------------------


def sections(text: str) -> dict[str, str]:
    """The CHANGELOG's `## [name]` sections, in order, each body without its blank edges."""
    found = list(SECTION.finditer(text))
    return {
        m.group("name"): text[m.end() : found[i + 1].start() if i + 1 < len(found) else len(text)].strip()
        for i, m in enumerate(found)
    }


def notes(root: Path, line: str, version: str) -> str:
    """The body of the version's section in the line's CHANGELOG; empty is only valid for `Unreleased`."""
    body = sections(_read(root, CHANGELOGS[line])).get(version)
    if body is None:
        msg = f"{CHANGELOGS[line]} has no [{version}] section"
        raise ValueError(msg)
    if not body and version != UNRELEASED:
        msg = f"{CHANGELOGS[line]}: the [{version}] section is empty"
        raise ValueError(msg)
    return body


def _check_changelog(root: Path, line: str, version: str) -> list[str]:
    rel = CHANGELOGS[line]
    if not (root / rel).exists():
        return [f"missing {rel}"]
    names = list(sections(_read(root, rel)))
    problems = []
    if not names or names[0] != UNRELEASED:
        problems.append(f"{rel}: the first section must be [{UNRELEASED}]")
    if version not in names:
        problems.append(f"{rel}: missing the [{version}] section of the current {line} version")
    problems += [f"{rel}: section [{n}] is not SemVer X.Y.Z" for n in names if n != UNRELEASED and not SEMVER.match(n)]
    if len(set(names)) != len(names):
        problems.append(f"{rel}: repeated section")
    return problems


def check(root: Path) -> list[str]:
    """The tree's problems: diverging fields, a version without a section, a migration without an entry."""
    problems = []
    for line in LINES:
        values = _values(root, line)
        problems += [f"{line}: no version in {label}" for label, value in values if value is None]
        distinct = {value for _, value in values if value is not None}
        if len(distinct) > 1:
            detail = ", ".join(f"{label}={value}" for label, value in values)
            problems.append(f"{line}: diverging versions ({detail}); run deploy/version.py set")
        if values[0][1] is not None:
            problems += _check_changelog(root, line, values[0][1])
    for rel in INITS:
        if re.search(r'(?m)^__version__ = ["\']', _read(root, rel)):
            problems.append(f"{rel}: literal __version__; read it from importlib.metadata.version")
    if (root / CHANGELOGS["product"]).exists():
        text = _read(root, CHANGELOGS["product"])
        for sql in sorted((root / MIGRATIONS).glob("*.sql")):
            if sql.stem not in text:
                problems.append(f"{CHANGELOGS['product']}: no entry mentions the migration {sql.stem}")
    return problems


def main(argv: list[str] | None = None) -> int:
    """Runs the requested subcommand."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=ROOT, help="repository root (default: this script's)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("current", help="the line's version").add_argument("line", choices=LINES)
    p_set = sub.add_parser("set", help="writes the version into every manifest of the line")
    p_set.add_argument("line", choices=LINES)
    p_set.add_argument("version")
    sub.add_parser("check", help="exits 1 if versions, CHANGELOGs or migrations diverge")
    p_notes = sub.add_parser("notes", help="the body of the version's section in the line's CHANGELOG")
    p_notes.add_argument("line", choices=LINES)
    p_notes.add_argument("version")
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):  # the notes go to the release in UTF-8, on Windows too
        stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]

    try:
        if args.command == "current":
            sys.stdout.write(current(args.root, args.line) + "\n")
        elif args.command == "set":
            for rel in set_version(args.root, args.line, args.version):
                sys.stdout.write(f"wrote {rel}\n")
        elif args.command == "notes":
            body = notes(args.root, args.line, args.version)
            sys.stdout.write(body + "\n" if body else "")
        else:
            problems = check(args.root)
            for problem in problems:
                sys.stderr.write(f"{problem}\n")
            if problems:
                return 1
            versions = ", ".join(f"{line} {current(args.root, line)}" for line in LINES)
            sys.stdout.write(f"versions up to date: {versions}\n")
    except (ValueError, OSError) as error:
        sys.stderr.write(f"{error}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
