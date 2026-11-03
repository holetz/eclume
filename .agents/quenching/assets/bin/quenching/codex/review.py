"""Run Codex as an independent reviewer of a worktree, and prove by code it changed nothing.

The argv is fixed here and nowhere else: `--dangerously-bypass-approvals-and-sandbox
--ignore-user-config --ignore-rules` always, so Codex's native sandbox is never asked for (it fails
on hosts without unprivileged user namespaces) and the user's `~/.codex/config.toml` (approval
policy, plugins, hooks) never applies; and never `--ephemeral`, which would erase the quota snapshot
the probe falls back on. The environment loses the same secrets as the executor's. The prompt
arrives on stdin, after the rule that Codex only reads; the events and the last message land in
`.quenching/codex/<run>/`.

The git guard is read before and after: the reviewed worktree's refs (`HEAD`, branch, reflog,
stash), the base checkout's `HEAD` and the primary branch ref (a fast-forward is accepted; a
rewind, a branch switch, a detached base `HEAD` or a removed ref is not), the index hash, the ignored local configuration (`.claude/**`, `*.local.json`)
and, for every path `git status` reports, its status and bytes. Any change, or a git command that
fails, is exit 2 `codex-git-guard` naming it: the caller never cleans it and hands the tree to the
human.

    exit 0  Codex finished, wrote the review and changed nothing
    exit 1  Codex failed, wrote nothing or ran past `timeoutSeconds` — the caller falls back
    exit 2  refusal: a missing worktree, prompt or `codex`, a worktree outside git, a run name
            already used; or `codex-git-guard`: the guard saw a change
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time

from quenching.codex.guard import (BYPASS, GuardError, base_moves, base_state, clean_env, git, refs,
                                   run_skip, strict_refs, tree)
from quenching.codex.probe import group_kwargs, stop

RUN_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
NOT_MEASURED = "not measured"
RULE = (
    "Regras do revisor: apenas leia. Não escreva, crie, mova nem apague nenhum arquivo, e não rode "
    "comandos git que alterem algo (commit, add, stash, reset, checkout, branch, push). Cite cada "
    "achado por path:line; o lado Claude reproduz cada achado antes de agir sobre ele.")


def build_argv(model: str, worktree: str, review_path: str) -> list[str]:
    return ["exec", BYPASS, "--ignore-user-config", "--ignore-rules",
            "-m", model, "-c", "model_reasoning_effort=high", "-C", worktree,
            "--json", "-o", review_path, "-"]


def _last_usage(node, found: list) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "total_token_usage" and isinstance(value, dict):
                found.append(value)
            else:
                _last_usage(value, found)
    elif isinstance(node, list):
        for item in node:
            _last_usage(item, found)


def _add_turn(totals: dict, usage: dict) -> None:
    for key, value in usage.items():
        if isinstance(value, int) and not isinstance(value, bool):
            totals[key] = totals.get(key, 0) + value


def measured_tokens(events_path: str):
    """The usage of every `turn.completed` that `codex exec --json` printed, summed.

    Without one, the last `total_token_usage` of the rollout format; without either,
    `not measured`. `total_tokens` is input plus output, as the event does not carry it.
    """
    turns: dict = {}
    found: list = []
    try:
        with open(events_path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(event, dict) and event.get("type") == "turn.completed" \
                        and isinstance(event.get("usage"), dict):
                    _add_turn(turns, event["usage"])
                else:
                    _last_usage(event, found)
    except OSError:
        return NOT_MEASURED
    if turns:
        turns["total_tokens"] = turns.get("input_tokens", 0) + turns.get("output_tokens", 0)
        return turns
    return found[-1] if found else NOT_MEASURED


def snapshot(worktree: str, skip: str | None) -> dict:
    try:
        return {**refs(worktree, strict=True), **strict_refs(worktree),
                "tree": tree(worktree, skip), "base": base_state(worktree)}
    except GuardError:
        raise
    except Exception as error:  # an unreadable file or any other failure: fail closed
        raise GuardError(f"{type(error).__name__}: {error}") from error


def refusal(code: str, message: str) -> tuple[dict, int]:
    return {"ok": False, "code": code, "message": message}, 2


def guard_refusal(message: str, run_dir: str | None, error: GuardError) -> tuple[dict, int]:
    """A `codex-git-guard` refusal carrying every key `cq codex review` prints, so the exit 2 that
    hands the tree to the human is never lost to a missing key."""
    return {"ok": False, "fallback": False, "code": "codex-git-guard", "message": message,
            "runDir": run_dir,
            "reason": f"git guard: {error}", "tokens": NOT_MEASURED, "guard": None,
            "changed": []}, 2


def run_review(root: str, settings: dict, worktree: str, prompt: str, run: str | None,
               env: dict | None = None) -> tuple[dict, int]:
    env = dict(os.environ if env is None else env)
    worktree, prompt = os.path.realpath(worktree), os.path.abspath(prompt)
    if not os.path.isdir(worktree):
        return refusal("codex-worktree-missing", f"worktree does not exist: {worktree}")
    if git(worktree, "rev-parse", "--is-inside-work-tree").strip() != "true":
        return refusal("codex-worktree-not-git",
                       f"worktree is not inside a git checkout, so no guard can hold: {worktree}")
    if not os.path.isfile(prompt):
        return refusal("codex-prompt-missing", f"prompt file does not exist: {prompt}")
    binary = shutil.which("codex", path=env.get("PATH"))
    if binary is None:
        return refusal("codex-missing", "codex is not on PATH")
    run = run or time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    if not RUN_NAME.match(run):
        return refusal("codex-run-name", f"run name must match {RUN_NAME.pattern}: {run}")
    run_dir = os.path.join(root, ".quenching", "codex", run)
    if os.path.exists(run_dir):
        return refusal("codex-run-exists", f"run directory already exists: {run_dir}")
    toplevel = os.path.realpath(git(worktree, "rev-parse", "--show-toplevel").strip())
    skip = run_skip(os.path.realpath(run_dir), toplevel)  # the run's own output

    os.makedirs(run_dir)
    prompt_path = os.path.join(run_dir, "prompt.md")
    with open(prompt, encoding="utf-8") as handle:
        text = handle.read().rstrip("\n")
    with open(prompt_path, "w", encoding="utf-8") as handle:
        handle.write(f"{text}\n\n{RULE}\n")
    review_path = os.path.join(run_dir, "review.md")
    events_path = os.path.join(run_dir, "events.jsonl")
    argv = build_argv(settings["model"], worktree, review_path)
    timed_out = False
    try:
        before = snapshot(toplevel, skip)
    except GuardError as error:
        shutil.rmtree(run_dir, ignore_errors=True)
        return guard_refusal(f"the guard cannot read the tree before the run, so nothing can "
                             f"be proved: {error}", None, error)
    with open(prompt_path, encoding="utf-8") as stdin, \
            open(events_path, "w", encoding="utf-8") as stdout, \
            open(os.path.join(run_dir, "stderr.log"), "w", encoding="utf-8") as stderr:
        process = subprocess.Popen([binary, *argv], stdin=stdin, stdout=stdout, stderr=stderr,
                                   cwd=worktree, env=clean_env(env), **group_kwargs())
        try:
            code = process.wait(timeout=settings["timeoutSeconds"])
        except subprocess.TimeoutExpired:
            stop(process)
            code, timed_out = process.returncode, True
    try:
        after = snapshot(toplevel, skip)
    except GuardError as error:
        return guard_refusal(f"the guard cannot read the tree after the run, so it cannot prove "
                             f"the review changed nothing: {error}. Stop and hand the tree to "
                             f"the human.", run_dir, error)
    wrote = os.path.isfile(review_path) and os.path.getsize(review_path) > 0
    out = {"ok": False, "fallback": True, "run": run, "runDir": run_dir,
           "reviewPath": review_path if wrote else None, "eventsPath": events_path,
           "argv": ["codex", *argv], "exitCode": code, "timedOut": timed_out,
           "model": settings["model"], "timeoutSeconds": settings["timeoutSeconds"],
           "tokens": measured_tokens(events_path), "guard": None, "changed": []}
    moved = sorted(key for key in before if key not in ("tree", "base") and before[key] != after[key])
    try:
        moved += base_moves(toplevel, before["base"], after["base"])
    except GuardError as error:
        return guard_refusal(f"the guard cannot compare the base checkout: {error}. Stop and "
                             f"hand the tree to the human.", run_dir, error)
    out["changed"] = sorted(path for path in before["tree"].keys() | after["tree"].keys()
                            if before["tree"].get(path) != after["tree"].get(path))
    if moved or out["changed"]:
        out["guard"] = {"moved": moved, "before": before, "after": after}
        detail = "; ".join(filter(None, [moved and "moved: " + ", ".join(moved),
                                         out["changed"] and "changed: "
                                         + ", ".join(out["changed"])]))
        return {**out, "fallback": False, "code": "codex-git-guard",
                "message": f"the review changed the tree — {detail}. Claude may not clean it "
                           "(no reset, stash, checkout or restore): stop and hand the tree to "
                           "the human, naming these paths.",
                "reason": f"git guard: {detail}"}, 2
    if timed_out:
        reason = f"codex ran past {settings['timeoutSeconds']}s and was stopped"
    elif code != 0:
        reason = f"codex exited {code}"
    elif not wrote:
        reason = "codex wrote no review"
    else:
        reason = "review written"
    ok = not timed_out and code == 0 and wrote
    return {**out, "ok": ok, "fallback": not ok, "reason": reason}, 0 if ok else 1
