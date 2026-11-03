"""The two ways this tool asks git a question — one that reads absence as a fact,
and one that reads git's own message and exit code.

Moved verbatim out of the pre-refactor specs script."""
from __future__ import annotations

import os

COMMAND_TIMEOUT_S = 60


def _git(cwd: str, *argv: str) -> str:
    """Stdout of one git command, or "" for every way it can fail — no git on PATH, not a
    repo, a nonzero exit. Every caller treats absence as "this repo has no git facts",
    which is a real state and never an error."""
    import subprocess
    try:
        out = subprocess.run(["git", *argv], capture_output=True, text=True,
                             timeout=COMMAND_TIMEOUT_S,
                             cwd=cwd if os.path.isdir(cwd) else ".")
        return out.stdout if out.returncode == 0 else ""
    except (OSError, ValueError, subprocess.SubprocessError):
        return ""


def _git_run(cwd: str, *argv: str, stdin: str | None = None,
             env: dict[str, str] | None = None) -> tuple[int, str, str]:
    """Exit code, stdout AND stderr of one git command — the two halves `_git` throws away.

    A SIBLING of `_git`, never a change to it: every existing caller reads `""` as "this repo
    has no git facts", which is a real state and never an error. Creating a worktree needs the
    opposite reading — the difference between "the branch is not there" and "git could not
    answer" is what decides whether a branch gets created — and it needs git's own message to
    quote back in a refusal.

    A cwd that does not exist is `127` and no subprocess, where `_git` falls back to `"."`.
    That fallback is harmless when the answer is only ever read as a fact; here it would run
    `git worktree add` in whatever directory the process happens to sit in."""
    import subprocess
    if not os.path.isdir(cwd):
        return 127, "", f"not a directory: {cwd}"
    try:
        out = subprocess.run(["git", *argv], capture_output=True, text=True,
                             timeout=COMMAND_TIMEOUT_S,
                             cwd=cwd, input=stdin, env=env)
        return out.returncode, out.stdout, out.stderr
    except (OSError, ValueError, subprocess.SubprocessError) as e:   # noqa: BLE001
        return 127, "", str(e)
