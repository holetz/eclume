"""Let Codex write one eligible spec task inside a worktree — and prove by code it touched nothing else.

The task is judged again by `eligibility` (the quota included), so a caller cannot dispatch what
`cq codex eligible` would refuse. The argv is fixed here: `--dangerously-bypass-approvals-and-sandbox
--ignore-user-config --ignore-rules -m <model> -c model_reasoning_effort=<effort> -C <worktree>
--json`. Codex's native sandbox is never asked for; the bounds are the plugin's. The environment
loses `GH_TOKEN`, `GITHUB_TOKEN` and every `AWS_*`, `AZURE_*` and `GOOGLE_*` variable; the prompt
forbids git and any write outside the task's `files:`.

The git guard is read before and after: the reviewed worktree's own `HEAD`, branch, reflog length
and stash ref (never another worktree's `HEAD`), the base checkout's `HEAD` and the primary branch
ref (a fast-forward is accepted; a rewind, a branch switch, a detached base `HEAD` or a removed
ref is a divergence), and `git status` contained in `files:`. A divergence is
exit 2 with the offending paths. With `outside` non-empty (paths `files:` never declared) Claude
may not clean them: it stops the task as `needs-human` naming them. With `outside` empty (a moved
`HEAD`, branch, reflog or stash) Claude discards the diff inside `files:` (never `reset`, `stash`
or `checkout`) and writes the task itself.

The quota is probed again afterwards. A primary window that moved by more than
`stopLossPercent` points sets `stopLoss`: the diff stands, and the executor stays off for the rest
of the execution.

    exit 0  Codex finished and its diff stays inside `files:` — Claude verifies, reviews, commits
    exit 1  fall back to Claude: ineligible, Codex failed or timed out
    exit 2  refusal (missing worktree, prompt, spec, task or `codex`, a dirty tree outside
            `files:`), or `codex-git-guard`: the guard saw a divergence
"""
from __future__ import annotations

import os
import shutil
import subprocess
import time

from quenching.codex.eligible import eligibility, strip_annotation
from quenching.codex.guard import (BYPASS, GuardError, base_moves, base_state, clean_env, git, refs,
                                   touched)
from quenching.codex.probe import group_kwargs, probe, stop
from quenching.codex.review import RUN_NAME, measured_tokens, refusal
from quenching.specs.backends import open_backend

RULE = (
    "Regras do executor: escreva apenas nos arquivos listados abaixo, dentro deste diretório. "
    "Não rode nenhum comando git (nem commit, stash, reset, checkout, branch ou push) e não "
    "escreva fora do diretório de trabalho. Não rode testes que gastem cota de agentes. "
    "O lado Claude verifica, revisa e faz o commit.")
WAY_OUT = ("Claude may not clean these paths (no reset, stash or checkout) and files: never "
           "declared them: stop the task as needs-human naming them, so the human cleans the tree.")


def build_argv(executor: dict, model: str, worktree: str, message_path: str) -> list[str]:
    return ["exec", BYPASS, "--ignore-user-config", "--ignore-rules", "-m", model,
            "-c", f"model_reasoning_effort={executor['reasoningEffort']}", "-C", worktree,
            "--json", "-o", message_path, "-"]


def primary_used(quota: dict | None):
    window = ((quota or {}).get("rateLimits") or {}).get("primary") or {}
    return window.get("usedPercent")


def read_task(root: str, spec: str, task_id: str) -> tuple[dict | None, tuple[dict, int] | None]:
    backend, err = open_backend(root)
    if err:
        return None, refusal("codex-specs-unreadable",
                             err.get("message", "the spec store could not be opened"))
    info, err = backend.read_spec(spec)
    if info is None:
        return None, refusal("codex-spec-missing", (err or {}).get("message", f"no spec {spec}"))
    task = next((t for t in info.get("tasks", []) if t["id"] == task_id), None)
    if task is None:
        return None, refusal("codex-task-missing", f"spec {spec} has no task {task_id}")
    return task, None


def run_implement(root: str, settings: dict, spec: str, task_id: str, worktree: str,
                  prompt: str, run: str | None, env: dict | None = None,
                  quota=None) -> tuple[dict, int]:
    """`quota` replaces the probe before and after, so tests never reach Codex."""
    env = dict(os.environ if env is None else env)
    quota = quota or probe
    worktree, prompt = os.path.realpath(worktree), os.path.abspath(prompt)
    if not os.path.isdir(worktree):
        return refusal("codex-worktree-missing", f"worktree does not exist: {worktree}")
    if os.path.realpath(git(worktree, "rev-parse", "--show-toplevel").strip() or "/") != worktree:
        return refusal("codex-worktree-not-toplevel",
                       f"worktree is not the top level of a git checkout: {worktree}")
    if not os.path.isfile(prompt):
        return refusal("codex-prompt-missing", f"prompt file does not exist: {prompt}")
    task, refused = read_task(root, spec, task_id)
    if refused:
        return refused
    files = sorted(strip_annotation(f).lstrip("/") for f in task["files"])
    dirty = sorted(touched(worktree) - set(files))
    if dirty:
        return refusal("codex-tree-dirty", "the tree is dirty outside files: "
                       + ", ".join(dirty) + f". {WAY_OUT}")
    binary = shutil.which("codex", path=env.get("PATH"))
    if binary is None:
        return refusal("codex-missing", "codex is not on PATH")
    run = run or time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    if not RUN_NAME.match(run):
        return refusal("codex-run-name", f"run name must match {RUN_NAME.pattern}: {run}")
    run_dir = os.path.join(root, ".quenching", "codex", run)
    if os.path.exists(run_dir):
        return refusal("codex-run-exists", f"run directory already exists: {run_dir}")

    judged, code = eligibility(task, settings, worktree, lambda s: quota(s, env=env))
    executor = settings["executor"]
    out = {"ok": False, "fallback": True, "spec": str(spec), "task": task_id, "files": files,
           "class": judged["class"], "model": judged["model"],
           "run": run, "runDir": None, "argv": None, "exitCode": None, "timedOut": False,
           "tokens": None, "quotaBefore": primary_used(judged["quota"]), "quotaAfter": None,
           "quotaDelta": None, "stopLoss": False, "guard": None, "outside": []}
    if code != 0:
        return {**out, "reason": judged["reason"]}, 1

    os.makedirs(run_dir)
    prompt_path = os.path.join(run_dir, "prompt.md")
    message_path = os.path.join(run_dir, "last-message.md")
    events_path = os.path.join(run_dir, "events.jsonl")
    with open(prompt, encoding="utf-8") as handle:
        text = handle.read().rstrip("\n")
    with open(prompt_path, "w", encoding="utf-8") as handle:
        handle.write(f"{text}\n\n{RULE}\n\nArquivos: {', '.join(files)}\n")
    argv = build_argv(executor, judged["model"], worktree, message_path)
    before = refs(worktree)
    try:
        base_before = base_state(worktree)
    except GuardError as error:
        shutil.rmtree(run_dir, ignore_errors=True)
        return {**out, "fallback": False, "code": "codex-git-guard",
                "message": f"the guard cannot read the base checkout before the run: {error}",
                "reason": f"git guard: {error}"}, 2
    with open(prompt_path, encoding="utf-8") as stdin, \
            open(events_path, "w", encoding="utf-8") as stdout, \
            open(os.path.join(run_dir, "stderr.log"), "w", encoding="utf-8") as stderr:
        process = subprocess.Popen([binary, *argv], stdin=stdin, stdout=stdout, stderr=stderr,
                                   cwd=worktree, env=clean_env(env), **group_kwargs())
        try:
            exit_code = process.wait(timeout=settings["timeoutSeconds"])
        except subprocess.TimeoutExpired:
            stop(process)
            exit_code, out["timedOut"] = process.returncode, True
    after = refs(worktree)
    base_after = base_before
    try:
        base_after = base_state(worktree, base_before["primary"])
        base_bad = base_moves(worktree, base_before, base_after)
    except GuardError as error:
        base_bad = [f"base unreadable ({error})"]
    out.update(runDir=run_dir, argv=["codex", *argv], exitCode=exit_code,
               tokens=measured_tokens(events_path))
    out["quotaAfter"] = primary_used(quota({**settings, "crossReview": "auto"}, env=env))
    if out["quotaBefore"] is not None and out["quotaAfter"] is not None:
        out["quotaDelta"] = out["quotaAfter"] - out["quotaBefore"]
        out["stopLoss"] = out["quotaDelta"] > executor["stopLossPercent"]

    out["outside"] = sorted(touched(worktree) - set(files))
    moved = sorted(key for key in before if before[key] != after[key]) + base_bad
    if moved or out["outside"]:
        out["guard"] = {"moved": moved, "before": {**before, "base": base_before},
                        "after": {**after, "base": base_after}}
        detail = "; ".join(filter(None, [moved and "moved: " + ", ".join(moved),
                                         out["outside"] and "outside files: "
                                         + ", ".join(out["outside"])]))
        way_out = f" {WAY_OUT}" if out["outside"] else ""
        return {**out, "fallback": False, "code": "codex-git-guard",
                "discard": files,
                "message": f"the git guard saw a divergence — {detail}.{way_out}",
                "reason": f"git guard: {detail}"}, 2
    if out["timedOut"]:
        reason = f"codex ran past {settings['timeoutSeconds']}s and was stopped"
    elif exit_code != 0:
        reason = f"codex exited {exit_code}"
    else:
        reason = "codex wrote the task"
    ok = not out["timedOut"] and exit_code == 0
    return {**out, "ok": ok, "fallback": not ok, "reason": reason}, 0 if ok else 1
