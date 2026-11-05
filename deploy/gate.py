# ruff: noqa: INP001  # loose script, called by the deploy scripts and the workflows; deploy/ is not a package
"""Logic of the eclume quality gate (the `eclume/gate` status on the commit), stdlib only.

Subcommands, all reading stdin:

- `decide` — the commit's combined status (`gh api repos/<repo>/commits/<sha>/status`); exits 0 only
  when the latest `eclume/gate` is `success` and otherwise states the state and exits 1;
- `describe` — one `<pillar> <exit code>` line per pillar run (`--duration <s>`, `--log <path>`,
  `--skipped a,b` and `--since <sha>` for the pillars the diff did not require); prints the final
  state (`success`, `failure` or `error`) and, on the next line, the status description, at most
  140 characters;
- `pillars` — the pillars the diff `--since <green-sha>` to `--sha` requires (`--repo` points at the
  git root), or that the stdin paths require (`--stdin`, one per line, for callers without git);
  `--all` or an impossible diff runs all of them; one pillar per line, in `PILLARS` order;
- `push-targets` — the pre-push hook's stdin; prints the SHA of each update of `refs/heads/main`,
  ignoring a deleted ref.

Contract: docs/standards/code/monorepo.md.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from typing import Any

CONTEXT = "eclume/gate"
PILLARS = (
    "python",
    "contracts",
    "web",
    "web-browser",
    "desktop",
    "mobile",
    "docs",
    "windows",
    "audit",
    "android",
    "gpu-e2e",
)
# Pillars only the gate runs: CI has no xwin, no network for the audit, no Android SDK (the verified
# APK build takes about 15 min) on every PR and no GPU for gpu-e2e.
GATE_ONLY = ("windows", "audit", "android", "gpu-e2e")
# Exit code of a pillar that could not prove (GPU busy past the wait): no proof, never green nor failure.
INCONCLUSIVE = 75
DESCRIPTION_LIMIT = 140

# Paths that require each pillar: the same map as the `.github/workflows/ci.yml` filters
# (`deploy/test_gate.py` fails if the two diverge) plus the pillars only the gate runs.
_CI = (".github/workflows/ci.yml", ".github/actions/**", "deploy/pillars.sh")
_UV = ("pyproject.toml", "uv.lock", ".python-version")
_DEPENDENCIES = (
    "pyproject.toml",
    "uv.lock",
    "web/package.json",
    "web/package-lock.json",
    "mobile/package.json",
    "mobile/package-lock.json",
    "desktop/package.json",
    "desktop/package-lock.json",
    "desktop/**/Cargo.toml",
    "desktop/Cargo.lock",
    "desktop/deny.toml",
    "mobile/**/Cargo.toml",
    "mobile/Cargo.lock",
    "mobile/deny.toml",
    "deploy/audit-exceptions.txt",
)
_DESKTOP = (
    *_CI,
    "desktop/**",
    "web/src/styles/eclume.css",
    "web/src/lib/vocabulario.js",
    "web/src/features/help/articles/en/**",
)
_MOBILE = (
    *_CI,
    "mobile/**",
    "desktop/crates/**",
    "web/src/lib/vocabulario.js",
    "web/src/lib/vocabulario.d.ts",
)
FILTERS: dict[str, tuple[str, ...]] = {
    "python": (
        *_CI,
        *_UV,
        "engines/**",
        "server/**",
        "worker-gpu/**",
        "contracts/**",
        "mobile/scripts/**",
        "design-system/**",
        "web/src/styles/eclume.css",
        "desktop/ui/eclume.css",
        "mobile/ui/src/styles/eclume.css",
        "deploy/**",
        ".github/workflows/desktop-release.yml",
        "CHANGELOG.md",
        "desktop/CHANGELOG.md",
        "mobile/CHANGELOG.md",
        "web/package.json",
        "web/package-lock.json",
        "desktop/**/Cargo.toml",
        "desktop/Cargo.lock",
        "desktop/src-tauri/tauri.conf.json",
        "mobile/**/Cargo.toml",
        "mobile/Cargo.lock",
        "mobile/src-tauri/tauri.conf.json",
    ),
    "contracts": (*_CI, *_UV, "contracts/**", "deploy/docker-compose.mock.yml"),
    "web": (*_CI, "web/**", "contracts/**"),
    "web-browser": (*_CI, "web/**", "contracts/**", "deploy/docker-compose.mock.yml"),
    "desktop": _DESKTOP,
    "mobile": _MOBILE,
    "docs": (*_CI, "docs/**", "**/*.md", "deploy/docs_check.py", "deploy/test_docs_check.py"),
    # Gate only: the Windows-only code is the desktop's; the APK is the mobile's; the audit reads the
    # dependencies (and the exceptions).
    "windows": _DESKTOP,
    "audit": (*_CI, *_DEPENDENCIES),
    "android": _MOBILE,
    # The CUDA proof: worker-gpu, the engines, the transcript schema, the test compose and the script.
    "gpu-e2e": (
        *_CI,
        "worker-gpu/**",
        "engines/**",
        "contracts/transcript.schema.json",
        "deploy/docker-compose.gpu-test.yml",
        "deploy/gpu-e2e.sh",
    ),
}
# When any of these changes, the gate runs every pillar: the gate itself and the deploy scripts, the
# locks and the toolchain (a new tool version can break any pillar).
TRIGGERS_OF_ALL = (
    "deploy/**",
    ".github/workflows/ci.yml",
    "pyproject.toml",
    "uv.lock",
    ".python-version",
    ".nvmrc",
    "**/rust-toolchain.toml",
    "**/Cargo.lock",
    "**/package-lock.json",
)
TARGET = "refs/heads/main"
NULL_SHA = "0" * 40


def gate_state(combined: dict[str, Any]) -> str | None:
    """State of `eclume/gate` in the combined status (the latest per context), or None."""
    for status in combined.get("statuses") or []:
        if status.get("context") == CONTEXT:
            return status.get("state")
    return None


def decide(combined: dict[str, Any]) -> tuple[bool, str]:
    """(cleared, message) for publishing the commit of the combined status."""
    state = gate_state(combined)
    if state == "success":
        return True, f"{CONTEXT} = success"
    if state is None:
        return False, f"{CONTEXT} missing on the commit (run bash deploy/gate.sh)"
    return False, f"{CONTEXT} = {state}, not success"


def _duration(seconds: int) -> str:
    minutes, sec = divmod(max(seconds, 0), 60)
    return f"{minutes}min{sec:02d}s" if minutes else f"{sec}s"


def _glob_regex(glob: str) -> re.Pattern[str]:
    """A CI filter glob (`**` crosses folders, `*` does not) as a regular expression."""
    out = []
    i = 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif glob.startswith("**", i):
            out.append(".*")
            i += 2
        elif glob[i] == "*":
            out.append("[^/]*")
            i += 1
        else:
            out.append(re.escape(glob[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def matches(path: str, globs: tuple[str, ...]) -> bool:
    """The path (relative to the root, with `/`) matches one of the globs."""
    return any(_glob_regex(g).match(path) for g in globs)


def required_pillars(files: list[str] | None) -> list[str]:
    """Pillars the set of changed files requires; `None` (unknown diff) requires all of them."""
    if files is None:
        return list(PILLARS)
    files = [f.strip().replace("\\", "/") for f in files if f.strip()]
    if any(matches(f, TRIGGERS_OF_ALL) for f in files):
        return list(PILLARS)
    return [p for p in PILLARS if any(matches(f, FILTERS[p]) for f in files)]


def changed_files(since: str, until: str, repo: str = ".") -> list[str] | None:
    """Files that changed from `since` to `until`, or None when git cannot say."""
    try:
        out = subprocess.run(  # noqa: S603
            ["git", "-C", repo, "diff", "--name-only", "--no-renames", "-z", f"{since}..{until}"],  # noqa: S607
            check=True,
            capture_output=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    return [f for f in out.decode("utf-8", "replace").split("\0") if f]


def describe(
    results: dict[str, int],
    duration_s: int,
    log: str,
    skipped: tuple[str, ...] = (),
    since: str = "",
) -> tuple[str, str]:
    """(state, description) of the status from each pillar's exit code.

    The `skipped` pillars are the ones the diff since the last green SHA (`since`) did not require:
    they do not count as missing, and the description says which ran and how many were left out.
    """
    inconclusive = [p for p in PILLARS if results.get(p) == INCONCLUSIVE and p == "gpu-e2e"]
    failed = [p for p in PILLARS if results.get(p, 0) != 0 and p not in inconclusive]
    missing = [p for p in PILLARS if p not in results and p not in skipped]
    if failed:
        state, summary = "failure", "failed: " + ", ".join(failed)
    elif missing or inconclusive:
        unproved = [p for p in PILLARS if p in missing or p in inconclusive]
        state, summary = "error", "no proof: " + ", ".join(unproved)
        if inconclusive:
            summary += " (inconclusive: GPU busy)"
    elif skipped:
        ran = [p for p in PILLARS if p in results]
        base = f"{len(ran)} green ({', '.join(ran)})" if ran else "no pillar required"
        state, summary = "success", f"{base}; {len(skipped)} skipped since {since[:7] or 'the last green'}"
    else:
        state, summary = "success", f"{len(PILLARS)} pillars green"
    text = f"{summary} · {_duration(duration_s)} · log {log}"
    if len(text) > DESCRIPTION_LIMIT:
        tail = f" · {_duration(duration_s)}"
        text = summary[: DESCRIPTION_LIMIT - len(tail) - 1] + "…" + tail
    return state, text


def read_results(lines: list[str]) -> dict[str, int]:
    """`<pillar> <code>` per line → {pillar: code}; a blank line is ignored."""
    results: dict[str, int] = {}
    for line in lines:
        parts = line.split()
        if not parts:
            continue
        if len(parts) != 2 or parts[0] not in PILLARS or not parts[1].isdigit():  # noqa: PLR2004
            raise ValueError(f"invalid result line: {line!r}")
        results[parts[0]] = int(parts[1])
    return results


def push_targets(lines: list[str]) -> list[str]:
    """SHAs pushed to `refs/heads/main` (the pre-push stdin format), without a deleted ref."""
    targets = []
    for line in lines:
        parts = line.split()
        if len(parts) != 4:  # noqa: PLR2004
            continue
        _local_ref, local_sha, remote_ref, _remote_sha = parts
        if remote_ref == TARGET and local_sha != NULL_SHA:
            targets.append(local_sha)
    return targets


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("decide")
    desc = sub.add_parser("describe")
    desc.add_argument("--duration", type=int, default=0)
    desc.add_argument("--log", default="")
    desc.add_argument("--skipped", default="")
    desc.add_argument("--since", default="")
    pil = sub.add_parser("pillars")
    pil.add_argument("--since", default="")
    pil.add_argument("--sha", default="HEAD")
    pil.add_argument("--repo", default=".")
    pil.add_argument("--all", action="store_true")
    pil.add_argument("--stdin", action="store_true")
    sub.add_parser("push-targets")
    args = parser.parse_args(argv)
    # The Windows workstation's Python would write in the console's code page.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if args.command == "pillars":
        files: list[str] | None = None
        if args.stdin and not args.all:
            files = sys.stdin.read().splitlines()
        elif args.since and not args.all:
            files = changed_files(args.since, args.sha, args.repo)
        sys.stdout.writelines(f"{p}\n" for p in required_pillars(files))
        return 0
    data = sys.stdin.read()

    if args.command == "decide":
        try:
            combined = json.loads(data or "{}")
        except json.JSONDecodeError:
            combined = {}
        cleared, message = decide(combined)
        sys.stdout.write(message + "\n")
        return 0 if cleared else 1
    if args.command == "describe":
        skipped = tuple(p for p in args.skipped.split(",") if p)
        state, text = describe(read_results(data.splitlines()), args.duration, args.log, skipped, args.since)
        sys.stdout.write(f"{state}\n{text}\n")
        return 0
    sys.stdout.writelines(f"{sha}\n" for sha in push_targets(data.splitlines()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
