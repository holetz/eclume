# ruff: noqa: INP001  # loose script, called by the test and by hand; deploy/ is not a Python package
"""Checks eclume's toolchain, action and image pins, stdlib only.

Flags:

- a workflow `uses:` without a commit SHA (40 hex) or without the version comment;
- a `runs-on` with `*-latest`;
- a `FROM`, `COPY --from=` or `image:` of an external image without `@sha256:` (the `eclume-*`
  images are built here and the Dockerfile's own stages do not count);
- `npx --yes` (or `-y`) in a script, workflow or Dockerfile;
- Rust missing, without an exact version or different between `desktop/` and `mobile/rust-toolchain.toml`;
- `@tauri-apps/cli` with a range, missing or different between `desktop/` and `mobile/package.json`;
- `.nvmrc` missing or `engines.node` diverging from it in the `package.json` of the npm projects;
- a directory with a manifest not covered by `.github/dependabot.yml`.

Usage: python3 deploy/pins.py [--root .]   (exits 1 and lists the problems, if any)
Contract: docs/standards/code/monorepo.md.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

SHA = re.compile(r"^[0-9a-f]{40}$")
EXACT_RUST = re.compile(r"^\d+\.\d+\.\d+$")
EXACT_SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
USES = re.compile(r"^\s*-?\s*uses:\s*(?P<ref>\S+)\s*(?:#\s*(?P<comment>\S.*))?$")
RUNS_ON = re.compile(r"^\s*runs-on:\s*(?P<value>\S+)")
NPX_YES = re.compile(r"\bnpx\s+(?:[^\n]*\s)?(?:--yes|-y)\b")
FROM = re.compile(r"^\s*FROM\s+(?:--platform=\S+\s+)?(?P<image>\S+)(?:\s+AS\s+(?P<stage>\S+))?", re.IGNORECASE)
COPY_FROM = re.compile(r"--from=(?P<image>\S+)")
IMAGE = re.compile(r"^\s*image:\s*(?P<image>\S+)")

# The repository's npm and cargo projects, with the Dependabot ecosystem that covers them.
NPM_PROJECTS = ("web", "mobile", "desktop", "desktop/ui-tests")
NODE_PROJECTS = ("web", "mobile", "desktop/ui-tests")
CARGO_PROJECTS = ("desktop", "mobile")


def local_image(image: str) -> bool:
    """Images built by the repository itself (`eclume-*`) do not come from a registry."""
    return image.rsplit("/", 1)[-1].startswith("eclume-")


def pinned_image(image: str) -> bool:
    """`name:tag@sha256:<64 hex>` (or just `name@sha256:`)."""
    return re.search(r"@sha256:[0-9a-f]{64}$", image) is not None


def workflow_problems(text: str, name: str) -> list[str]:
    """Actions without a SHA or without a version comment, and `*-latest` runners."""
    problems = []
    for n, line in enumerate(text.splitlines(), 1):
        if m := USES.match(line):
            ref = m["ref"].strip("'\"")
            if ref.startswith("./"):
                continue
            _, _, version = ref.partition("@")
            if not SHA.match(version):
                problems.append(f"{name}:{n}: action {ref} without a commit SHA")
            elif not m["comment"]:
                problems.append(f"{name}:{n}: action {ref} without the version comment")
        if (m := RUNS_ON.match(line)) and m["value"].endswith("-latest"):
            problems.append(f"{name}:{n}: runs-on {m['value']} (name the image)")
        # The runner also arrives through a matrix (`os: windows-latest`); a comment does not count.
        runner = re.search(r"\b(?:ubuntu|windows|macos)-latest\b", line)
        if runner and not RUNS_ON.match(line) and not line.lstrip().startswith("#"):
            problems.append(f"{name}:{n}: runner {runner[0]} (name the image)")
    return problems


VARIABLE = re.compile(r"\$\{[^}]+\}|\$\w+")


def chosen_stage(image: str, stages: set[str]) -> bool:
    """`FROM stage-${ARG}`: with a variable, the reference is a stage if it matches one of them."""
    if "$" not in image:
        return image in stages
    pattern = ".+".join(re.escape(part) for part in VARIABLE.split(image))
    return any(re.fullmatch(pattern, stage) for stage in stages)


def dockerfile_problems(text: str, name: str) -> list[str]:
    """External `FROM` and `COPY --from=` without a digest."""
    problems = []
    stages: set[str] = set()
    for n, line in enumerate(text.splitlines(), 1):
        if m := FROM.match(line):
            image = m["image"]
            if not chosen_stage(image, stages) and not local_image(image) and not pinned_image(image):
                problems.append(f"{name}:{n}: FROM {image} without @sha256:")
            if m["stage"]:
                stages.add(m["stage"])
        if line.lstrip().upper().startswith("COPY") and (m := COPY_FROM.search(line)):
            image = m["image"]
            if image not in stages and not image.isdigit() and not pinned_image(image):
                problems.append(f"{name}:{n}: COPY --from={image} without @sha256:")
    return problems


def compose_problems(text: str, name: str) -> list[str]:
    """External `image:` without a digest."""
    problems = []
    for n, line in enumerate(text.splitlines(), 1):
        if m := IMAGE.match(line):
            image = m["image"].strip("'\"")
            if not local_image(image) and not pinned_image(image):
                problems.append(f"{name}:{n}: image {image} without @sha256:")
    return problems


def npx_problems(text: str, name: str) -> list[str]:
    """`npx --yes` downloads and runs whatever the network serves that day."""
    return [
        f"{name}:{n}: npx --yes (use the lockfile and npx --no-install)"
        for n, line in enumerate(text.splitlines(), 1)
        if NPX_YES.search(line)
    ]


def rust_version(text: str | None) -> str | None:
    """`toolchain.channel` of a `rust-toolchain.toml`, or None."""
    if text is None:
        return None
    return tomllib.loads(text).get("toolchain", {}).get("channel")


def rust_problems(desktop: str | None, mobile: str | None) -> list[str]:
    """Both `rust-toolchain.toml` files exist, with the same exact version."""
    problems = []
    versions = {"desktop": rust_version(desktop), "mobile": rust_version(mobile)}
    for pillar, version in versions.items():
        if version is None:
            problems.append(f"{pillar}/rust-toolchain.toml missing or without toolchain.channel")
        elif not EXACT_RUST.match(version):
            problems.append(f"{pillar}/rust-toolchain.toml: channel {version} is not an exact version")
    if None not in versions.values() and versions["desktop"] != versions["mobile"]:
        problems.append(f"Rust differs: desktop {versions['desktop']}, mobile {versions['mobile']}")
    return problems


def tauri_cli_version(package: dict | None) -> str | None:
    """The declared version of `@tauri-apps/cli` in a `package.json`, or None."""
    if package is None:
        return None
    for section in ("devDependencies", "dependencies"):
        if version := (package.get(section) or {}).get("@tauri-apps/cli"):
            return version
    return None


def tauri_problems(desktop: dict | None, mobile: dict | None) -> list[str]:
    """The Tauri CLI is exact and the same in desktop and mobile."""
    problems = []
    versions = {"desktop": tauri_cli_version(desktop), "mobile": tauri_cli_version(mobile)}
    for pillar, version in versions.items():
        if version is None:
            problems.append(f"{pillar}/package.json without @tauri-apps/cli")
        elif not EXACT_SEMVER.match(version):
            problems.append(f"{pillar}/package.json: @tauri-apps/cli {version} is not an exact version")
    if None not in versions.values() and versions["desktop"] != versions["mobile"]:
        problems.append(f"@tauri-apps/cli differs: desktop {versions['desktop']}, mobile {versions['mobile']}")
    return problems


def node_problems(nvmrc: str | None, packages: dict[str, dict]) -> list[str]:
    """`.nvmrc` with the major and `engines.node` equal to it in each project."""
    if nvmrc is None or not nvmrc.strip().isdigit():
        return [".nvmrc missing or without the Node major"]
    major = nvmrc.strip()
    problems = []
    for project, package in packages.items():
        engine = (package.get("engines") or {}).get("node")
        if engine != major:
            problems.append(f"{project}/package.json: engines.node {engine!r}, expected {major!r} from .nvmrc")
    return problems


def dependabot_coverage(text: str) -> set[tuple[str, str]]:
    """(ecosystem, directory without slashes) of each `updates` entry of `dependabot.yml`."""
    covered = set()
    ecosystem = None
    for line in text.splitlines():
        if m := re.match(r"^\s*-\s*package-ecosystem:\s*['\"]?([\w-]+)", line):
            ecosystem = m[1]
        elif (m := re.match(r"^\s*directory:\s*['\"]?([^'\"\s]+)", line)) and ecosystem:
            covered.add((ecosystem, m[1].strip("/")))
        elif (m := re.match(r"^\s*-\s*['\"]?(/[^'\"\s]*)['\"]?\s*$", line)) and ecosystem:
            covered.add((ecosystem, m[1].strip("/")))  # an item of `directories:`
    return covered


def dependabot_problems(text: str | None, expected: set[tuple[str, str]]) -> list[str]:
    """Every expected (ecosystem, directory) pair appears in `dependabot.yml`."""
    if text is None:
        return [".github/dependabot.yml missing"]
    covered = dependabot_coverage(text)
    return [f"dependabot without {eco} in /{folder}" for eco, folder in sorted(expected - covered)]


def expected_dependabot(root: Path) -> set[tuple[str, str]]:
    """The (ecosystem, directory) pairs the repository's manifests ask for."""
    expected = {("uv", ""), ("github-actions", ""), ("docker-compose", "deploy"), ("docker", "deploy")}
    expected |= {("npm", p) for p in NPM_PROJECTS if (root / p / "package.json").exists()}
    expected |= {("cargo", p) for p in CARGO_PROJECTS if (root / p / "Cargo.toml").exists()}
    expected |= {("rust-toolchain", p) for p in CARGO_PROJECTS}
    expected |= {("docker", str(d.parent.relative_to(root)).replace("\\", "/")) for d in root.glob("*/*Dockerfile")}
    if (root / "mobile/src-tauri/gen/android/build.gradle.kts").exists():
        expected.add(("gradle", "mobile/src-tauri/gen/android"))
    return expected


def _read(path: Path) -> str | None:
    return path.read_text(encoding="utf-8") if path.exists() else None


def _json(path: Path) -> dict | None:
    text = _read(path)
    return json.loads(text) if text is not None else None


def check(root: Path) -> list[str]:
    """Every pin problem of the repository at `root`."""
    problems: list[str] = []
    for wf in sorted((root / ".github/workflows").glob("*.yml")):
        text = wf.read_text(encoding="utf-8")
        problems += workflow_problems(text, wf.name) + npx_problems(text, wf.name)
    for df in sorted({*root.glob("*/*Dockerfile"), *root.glob("*/*.Dockerfile")}):
        text = df.read_text(encoding="utf-8")
        rel = df.relative_to(root).as_posix()
        problems += dockerfile_problems(text, rel) + npx_problems(text, rel)
    for compose in sorted(root.glob("deploy/docker-compose*.yml")):
        problems += compose_problems(compose.read_text(encoding="utf-8"), compose.relative_to(root).as_posix())
    for script in sorted({*root.glob("deploy/*.sh"), *root.glob("*/scripts/*.sh")}):
        problems += npx_problems(script.read_text(encoding="utf-8"), script.relative_to(root).as_posix())
    problems += rust_problems(_read(root / "desktop/rust-toolchain.toml"), _read(root / "mobile/rust-toolchain.toml"))
    problems += tauri_problems(_json(root / "desktop/package.json"), _json(root / "mobile/package.json"))
    packages = {p: _json(root / p / "package.json") or {} for p in NODE_PROJECTS}
    problems += node_problems(_read(root / ".nvmrc"), packages)
    problems += dependabot_problems(_read(root / ".github/dependabot.yml"), expected_dependabot(root))
    return problems


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args(argv)
    problems = check(args.root)
    sys.stdout.writelines(f"{p}\n" for p in problems)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
