# ruff: noqa: INP001, S101  # loose tests of the deploy scripts; deploy/ is not a Python package
"""Tests of `pins.py`: each refusal proved by a fixture, and the repository without regression."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import yaml

_spec = importlib.util.spec_from_file_location("pins", Path(__file__).with_name("pins.py"))
assert _spec is not None
assert _spec.loader is not None
pins = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pins)

ROOT = Path(__file__).resolve().parent.parent
SHA = "0123456789abcdef0123456789abcdef01234567"
DIGEST = "@sha256:" + "a" * 64


def repo_problems(prefix: str) -> list[str]:
    """The repository's problems whose text starts with one of the prefixes (separated by `|`)."""
    return [p for p in pins.check(ROOT) if p.startswith(tuple(prefix.split("|")))]


# --- fixtures: each refusal -----------------------------------------------------------------------


def test_fixture_workflow_refuses_a_moving_tag_and_accepts_a_sha_with_comment() -> None:
    """An action by tag, or by SHA without the version comment, is refused; `./` is local."""
    text = f"""
      - uses: actions/checkout@v7
      - uses: actions/setup-node@{SHA}
      - uses: actions/setup-uv@{SHA} # v8.0.0
      - uses: ./.github/actions/local
"""
    problems = pins.workflow_problems(text, "ci.yml")
    assert [p.split(": ", 1)[1] for p in problems] == [
        "action actions/checkout@v7 without a commit SHA",
        f"action actions/setup-node@{SHA} without the version comment",
    ]


def test_fixture_workflow_refuses_a_latest_runner_also_in_the_matrix() -> None:
    """`runs-on: ubuntu-latest` and `os: windows-latest` in the matrix are refused; a comment is not."""
    text = """
    runs-on: ubuntu-latest
    # moves from windows-latest to windows-2025
    targets = [{"os": "windows-latest"}]
    runs-on: ubuntu-24.04
"""
    problems = pins.workflow_problems(text, "x.yml")
    assert [p.split(": ", 1)[1] for p in problems] == [
        "runs-on ubuntu-latest (name the image)",
        "runner windows-latest (name the image)",
    ]


def test_fixture_dockerfile_refuses_an_external_image_without_digest() -> None:
    """External `FROM` and `COPY --from=` need a digest; a stage and `eclume-*` do not."""
    text = f"""FROM node:22-bookworm-slim AS build
FROM python:3.12-slim{DIGEST} AS final
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
COPY --from=ghcr.io/astral-sh/uv:0.11{DIGEST} /uvx /usr/local/bin/uvx
COPY --from=build /app /app
FROM eclume-desktop-build:24.04
FROM build
FROM bu${{TARGET}} AS chosen
FROM node:${{VERSION}}
"""
    problems = pins.dockerfile_problems(text, "x.Dockerfile")
    assert problems == [
        "x.Dockerfile:1: FROM node:22-bookworm-slim without @sha256:",
        "x.Dockerfile:3: COPY --from=ghcr.io/astral-sh/uv:0.11 without @sha256:",
        "x.Dockerfile:9: FROM node:${VERSION} without @sha256:",
    ]


def test_fixture_compose_image_without_digest() -> None:
    """An external `image:` without a digest is refused; the eclume images are not."""
    text = f"""
    image: redis:7-alpine
    image: "pgvector/pgvector:pg16{DIGEST}"
    image: eclume-server:prod
"""
    assert pins.compose_problems(text, "c.yml") == ["c.yml:2: image redis:7-alpine without @sha256:"]


def test_fixture_npx_yes_refused() -> None:
    """`npx --yes` and `npx -y` download whatever the network serves; `--no-install` reads the lockfile."""
    text = "npx --yes @tauri-apps/cli@2 build\nnpx -y playwright@1 install\nnpx --no-install tauri build\n"
    assert [p.split(":")[1] for p in pins.npx_problems(text, "s.sh")] == ["1", "2"]


def test_fixture_rust_exact_and_equal_in_both_pillars() -> None:
    """Without a file, with `stable` or with different versions, Rust is refused."""
    toml = '[toolchain]\nchannel = "{}"\n'
    assert pins.rust_problems(toml.format("1.90.0"), toml.format("1.90.0")) == []
    assert "missing" in pins.rust_problems(None, toml.format("1.90.0"))[0]
    assert "is not an exact version" in pins.rust_problems(toml.format("stable"), toml.format("1.90.0"))[0]
    assert "Rust differs" in pins.rust_problems(toml.format("1.90.0"), toml.format("1.91.0"))[0]


def test_fixture_tauri_cli_exact_and_equal() -> None:
    """The Tauri CLI with a range, missing or diverging between desktop and mobile is refused."""
    exact = {"devDependencies": {"@tauri-apps/cli": "2.12.0"}}
    assert pins.tauri_problems(exact, exact) == []
    assert (
        "is not an exact version" in pins.tauri_problems(exact, {"devDependencies": {"@tauri-apps/cli": "^2.9.0"}})[0]
    )
    assert "without @tauri-apps/cli" in pins.tauri_problems({}, exact)[0]
    assert "differs" in pins.tauri_problems(exact, {"dependencies": {"@tauri-apps/cli": "2.11.0"}})[0]


def test_fixture_node_from_nvmrc_in_engines() -> None:
    """Without `.nvmrc`, or with a diverging `engines.node`, Node is refused."""
    assert pins.node_problems(None, {}) == [".nvmrc missing or without the Node major"]
    problems = pins.node_problems("22\n", {"web": {"engines": {"node": "22"}}, "mobile": {}})
    assert problems == ["mobile/package.json: engines.node None, expected '22' from .nvmrc"]


def test_fixture_dependabot_covers_each_manifest() -> None:
    """An (ecosystem, directory) pair without an entry in `dependabot.yml` is refused."""
    text = """
updates:
  - package-ecosystem: npm
    directories:
      - "/web"
      - "/mobile"
  - package-ecosystem: uv
    directory: "/"
"""
    expected = {("npm", "web"), ("npm", "mobile"), ("uv", ""), ("cargo", "desktop")}
    assert pins.dependabot_problems(text, expected) == ["dependabot without cargo in /desktop"]
    assert pins.dependabot_problems(None, expected) == [".github/dependabot.yml missing"]


# --- the repository -------------------------------------------------------------------------------


def test_repo_rust() -> None:
    """Rust pinned and equal in desktop and mobile."""
    assert repo_problems("desktop/rust-toolchain|mobile/rust-toolchain|Rust") == []


def test_repo_node() -> None:
    """`.nvmrc` and `engines.node` in every npm project."""
    assert repo_problems(".nvmrc|web/package.json|mobile/package.json: engines|desktop/ui-tests") == []


def test_repo_tauri() -> None:
    """The Tauri CLI exact and equal in desktop and mobile."""
    assert [p for p in pins.check(ROOT) if "@tauri-apps/cli" in p] == []


def test_repo_dockerfile() -> None:
    """Every external base image of the desktop Dockerfiles by digest, without `npx --yes`."""
    assert repo_problems("desktop/build") == []


def test_repo_workflow() -> None:
    """Every action by SHA, no `*-latest` runner, no `npx --yes` in the workflows."""
    assert [p for p in pins.check(ROOT) if p.split(":", 1)[0].endswith(".yml") and "/" not in p.split(":", 1)[0]] == []


def test_repo_image() -> None:
    """Every external image of the `deploy/` and worker Dockerfiles and composes by digest."""
    assert [p for p in repo_problems("deploy/|worker-gpu/") if "@sha256:" in p] == []


def test_repo_dependabot() -> None:
    """Every directory with a manifest covered by Dependabot."""
    assert repo_problems(".github/dependabot|dependabot") == []


def test_repo_has_no_problem_at_all() -> None:
    """The whole set: no pin has regressed."""
    assert pins.check(ROOT) == []


def test_repo_dependabot_weekly_grouped_with_cooldown() -> None:
    """Each Dependabot entry is weekly, grouped and waits 7 days after publication."""
    config = yaml.safe_load((ROOT / ".github/dependabot.yml").read_text(encoding="utf-8"))
    for entry in config["updates"]:
        assert entry["schedule"]["interval"] == "weekly", entry
        assert entry["cooldown"]["default-days"] == 7, entry  # noqa: PLR2004
        assert entry["groups"], entry
