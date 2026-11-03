"""The git guard: what a Codex run must leave as it found it, read without writing anything.

Codex runs with `--dangerously-bypass-approvals-and-sandbox`, so its bounds are proved by code
here, before and after the run. `refs` are the worktree's `HEAD`, branch, reflog length and stash
ref: the guard proves the reviewed worktree unchanged, never a neighbouring worktree's `HEAD` or a
ref of the shared repository, which a parallel worker moves legitimately. The one shared thing it
does watch is the base checkout (the main worktree of `git worktree list`) and the primary
branch ref: `base_state` and `base_moves` accept a fast-forward there (the new value descends from
the old one) and bar a rewind or rewrite, a switch of the base `HEAD`'s branch, a detached base
`HEAD` and the removal of the ref. `tree` maps every path `git status` reports to its status code and
the hash of its bytes, so the review can prove it changed nothing at all. The review's snapshot
also holds the hash of the index and the ignored files that carry local configuration
(`.claude/**` and `*.local.json`), the `ls-files -v` flags and the bytes of every file they hide
(`assume-unchanged`, `skip-worktree`), and a symlink by its target. A git command that fails is `GuardError`: the guard fails
closed, never as an empty tree.
"""
from __future__ import annotations

import hashlib
import os
import subprocess

BYPASS = "--dangerously-bypass-approvals-and-sandbox"
SECRET_NAMES = ("GH_TOKEN", "GITHUB_TOKEN")
SECRET_PREFIXES = ("AWS_", "AZURE_", "GOOGLE_")


def clean_env(env: dict) -> dict:
    """The environment a bypassed Codex gets: no forge token and no cloud credential."""
    return {k: v for k, v in env.items()
            if k not in SECRET_NAMES and not k.startswith(SECRET_PREFIXES)}


def git(worktree: str, *args: str) -> str:
    result = subprocess.run(["git", "-C", worktree, *args], capture_output=True, text=True,
                            errors="replace")
    return result.stdout if result.returncode == 0 else ""


class GuardError(Exception):
    """A git command the guard depends on failed, so nothing can be proved."""


def git_strict(worktree: str, *args: str) -> str:
    result = subprocess.run(["git", "-C", worktree, *args], capture_output=True, text=True,
                            errors="replace")
    if result.returncode != 0:
        raise GuardError(f"git {' '.join(args)} failed ({result.returncode}): "
                         f"{result.stderr.strip()}")
    return result.stdout


def status(worktree: str, strict: bool = False) -> list[tuple[str, str]]:
    """Every `(XY, path)` `git status` reports, rename sources included."""
    run = git_strict if strict else git
    entries = run(worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all").split("\0")
    out: list[tuple[str, str]] = []
    source = None
    for entry in entries:
        if source is not None:
            out.append((source, entry))
            source = None
            continue
        if len(entry) > 3:
            out.append((entry[:2], entry[3:]))
            source = entry[:2] if "R" in entry[:2] or "C" in entry[:2] else None
    return out


def touched(worktree: str) -> set[str]:
    return {path for _, path in status(worktree)}


def _state(worktree: str, *args: str) -> str:
    """Strict read of a query whose exit 1 with no message means "absent" (a detached HEAD has no
    symbolic ref, a repository without a stash has no `refs/stash`): that is state, not failure."""
    result = subprocess.run(["git", "-C", worktree, *args], capture_output=True, text=True,
                            errors="replace")
    if result.returncode == 1 and not result.stderr.strip():
        return ""
    if result.returncode != 0:
        raise GuardError(f"git {' '.join(args)} failed ({result.returncode}): "
                         f"{result.stderr.strip()}")
    return result.stdout


def refs(worktree: str, strict: bool = False) -> dict:
    """The refs of this worktree Codex must not move. `strict` raises `GuardError` when git fails, instead of
    reading the failure as an empty value."""
    run, state = (git_strict, _state) if strict else (git, git)
    return {"head": run(worktree, "rev-parse", "HEAD").strip(),
            "branch": state(worktree, "symbolic-ref", "-q", "HEAD").strip(),
            "reflogLength": len(run(worktree, "reflog", "--format=%H").splitlines()),
            "stash": state(worktree, "rev-parse", "-q", "--verify", "refs/stash").strip()}


def _ancestor(worktree: str, old: str, new: str) -> bool:
    """Whether `new` descends from (or equals) `old`; any git failure other than "no" is fatal."""
    result = subprocess.run(["git", "-C", worktree, "merge-base", "--is-ancestor", old, new],
                            capture_output=True, text=True, errors="replace")
    if result.returncode not in (0, 1):
        raise GuardError(f"git merge-base --is-ancestor failed ({result.returncode}): "
                         f"{result.stderr.strip()}")
    return result.returncode == 0


def _primary(worktree: str, base: str) -> str:
    """The primary branch ref: `origin/HEAD`'s target, else the base checkout's branch, else
    `main` or `master`, whichever exists."""
    head = _state(worktree, "symbolic-ref", "-q", "refs/remotes/origin/HEAD").strip()
    if head.startswith("refs/remotes/origin/"):
        return "refs/heads/" + head[len("refs/remotes/origin/"):]
    branch = _state(base, "symbolic-ref", "-q", "HEAD").strip()
    if branch:
        return branch
    for name in ("main", "master"):
        if _state(worktree, "rev-parse", "-q", "--verify", f"refs/heads/{name}").strip():
            return f"refs/heads/{name}"
    return ""


def base_state(worktree: str, primary: str | None = None) -> dict:
    """The base checkout's `HEAD` and branch and the primary branch ref's value. Fails closed."""
    listing = git_strict(worktree, "worktree", "list", "--porcelain")
    base = next((line[len("worktree "):] for line in listing.splitlines()
                 if line.startswith("worktree ")), "")
    if not base:
        raise GuardError("git worktree list names no base checkout")
    primary = primary if primary is not None else _primary(worktree, base)
    return {"path": base, "primary": primary,
            "head": _state(base, "rev-parse", "-q", "--verify", "HEAD").strip(),
            "branch": _state(base, "symbolic-ref", "-q", "HEAD").strip(),
            "primaryRef": (_state(worktree, "rev-parse", "-q", "--verify", primary).strip()
                           if primary else "")}


def base_moves(worktree: str, before: dict, after: dict) -> list[str]:
    """What moved in the base checkout or the primary ref that is not a fast-forward."""
    out: list[str] = []
    if before["branch"] != after["branch"]:
        out.append("base branch switched" if after["branch"] else "base HEAD detached")
    elif not after["branch"] and before["head"] != after["head"]:
        out.append("base HEAD detached")
    if before["head"] != after["head"] and after["head"] and before["head"] and \
            not _ancestor(worktree, before["head"], after["head"]):
        out.append("base HEAD rewound")
    if before["primaryRef"]:
        if not after["primaryRef"]:
            out.append("primary ref removed")
        elif before["primaryRef"] != after["primaryRef"] and \
                not _ancestor(worktree, before["primaryRef"], after["primaryRef"]):
            out.append("primary ref rewound")
    return out


def _digest(full: str) -> str:
    body = "-"
    if os.path.isfile(full):
        with open(full, "rb") as handle:
            body = hashlib.sha256(handle.read()).hexdigest()
    if os.path.islink(full):
        return f"link:{os.readlink(full)} {body}"
    return body


def run_skip(run_dir: str, toplevel: str, pathmod=os.path) -> str | None:
    """The run's own output as a `/`-separated path under `toplevel`, as `git status` prints it.
    `None` when the folder is outside the worktree, including a different drive (`ValueError`)."""
    try:
        inside = pathmod.relpath(run_dir, toplevel)
    except ValueError:
        return None
    if pathmod.sep != "/":
        inside = inside.replace(pathmod.sep, "/")
    return None if inside == ".." or inside.startswith("../") else inside


def _skipped(path: str, skip: str | None) -> bool:
    if not skip:
        return False
    if os.sep != "/":
        skip = skip.replace(os.sep, "/")
    skip = skip.rstrip("/")
    return path == skip or path.startswith(skip + "/")


def _local_config(path: str) -> bool:
    return path.startswith(".claude/") or path.endswith(".local.json")


def strict_refs(worktree: str) -> dict:
    """The hash of the index (`ls-files -s`) and of its flags (`ls-files -v`); fails closed."""
    flags = git_strict(worktree, "ls-files", "-v", "-z")
    return {"index": hashlib.sha256(
                git_strict(worktree, "ls-files", "-s", "-z").encode("utf-8", "replace")
            ).hexdigest(),
            "flags": hashlib.sha256(flags.encode("utf-8", "replace")).hexdigest()}


def tree(worktree: str, skip: str | None = None) -> dict[str, str]:
    """`path -> "XY sha256"` for every path `git status` reports, except those under `skip`, plus
    the ignored files that hold local configuration. Raises `GuardError` if git fails."""
    out: dict[str, str] = {}
    for code, path in status(worktree, strict=True):
        if _skipped(path, skip):
            continue
        out[path] = f"{code} {_digest(os.path.join(worktree, path))}"
    for entry in git_strict(worktree, "ls-files", "-v", "-z").split("\0"):
        # assume-unchanged (lowercase) and skip-worktree (`S`) hide edits from `git status`
        if len(entry) > 2 and entry[0] != "H" and not _skipped(entry[2:], skip):
            out.setdefault(entry[2:], f"{entry[0]} {_digest(os.path.join(worktree, entry[2:]))}")
    for entry in git_strict(worktree, "ls-files", "-s", "-z").split("\0"):
        # a tracked, clean symlink is invisible to `git status`; its target is not
        if entry.startswith("120000 "):
            path = entry.split("\t", 1)[1]
            full = os.path.join(worktree, path)
            if os.path.isfile(full) and not _skipped(path, skip):
                out.setdefault(path, f"L {_digest(full)}")
    ignored = git_strict(worktree, "ls-files", "--others", "--ignored", "--exclude-standard",
                         "-z").split("\0")
    for path in ignored:
        if not path or _skipped(path, skip):
            continue
        full = os.path.join(worktree, path)
        if _local_config(path) or (os.path.islink(full) and os.path.isfile(full)):
            out[path] = f"!! {_digest(full)}"
    return out
