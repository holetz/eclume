---
description: "Prune merged or gone branches and orphan worktrees from `.agents/quenching/bin/cq git stale`. Use for \"clean up old branches\", \"prune stale branches\". Not for: isolation → /quenching-git-branch."
disable-model-invocation: true
argument-hint: "[remote:<name>]"
allowed-tools: Bash(.agents/quenching/bin/cq:*), Bash(.agents/quenching/bin/cq.cmd:*), Bash(python3:*), Read, AskUserQuestion
---

# /quenching-git-cleanup — prune what `.agents/quenching/bin/cq git stale` already found

**Input**: `$ARGUMENTS` — optional `remote:<name>`; omitted → `origin`. This command always starts
from a fresh report for the selected remote.

## Workflow

### 1. Ask the tool for the current report
```bash
.agents/quenching/bin/cq git stale --remote <remote> --json
```
The report contains local `staleBranches` (removable), `keptBranches` (staying, with reasons), fetched `remoteBranches` from `<remote>`, registered
`orphanWorktrees`, assessed `worktrees`, the `manifest` and its `groups`, and unregistered `unregisteredWorktrees` siblings with their path, branch and
size. `manifest` empty → say so and stop; there is nothing to prune. The `manifest` is the complete list, so a candidate that sits in no legacy list (a detached worktree) still keeps the run going. Do not fetch or run `git
remote prune` here: if the caller needs newer remote facts, it must fetch explicitly and start a
fresh cleanup run. The report's `remote` must equal the selected remote. **Done when:** the manifest and the selected remote are in hand.

### 2. Let the human pick what to prune
The report's `manifest` is the complete list: every entry carries a stable `id`, `kind`, `ref`, the
observed `tip`, `tipDate` (the committer date of that tip, never creation or last use; `null` when
unknown) with its `dateSource`, `status` (`candidate` or `preserved`), `reasons`, the exact
`action` and a `recommended` flag. Show every `preserved` entry (kept branches, ineligible
worktrees) with its reasons as information under "kept — not removable", and do not include it in the
prune choices. Show each `unregisteredWorktrees` finding with its path, branch and size as
information too.

Present concise choices, not one line per entry: summarize the report's `groups` (homogeneous
candidates by scope, kind, reasons and date provenance) with their count and `oldest`–`newest` tip
date, and expand an entry only when it stands alone. A group resolves to the `ids` it displays —
never to a target discovered later — and every selected item has its exact action available on
request (`git branch -d <branch>`, `git worktree remove <path>`; `.agents/quenching/bin/cq git prune` runs them).

Put ONE decision sheet ([specs-develop/questions.md](.agents/quenching/assets/references/specs-develop/questions.md) §1) that ends the turn; its decision lists the local
groups and items as numbered choices and accepts several in the reply (`D1 1,3`), or `none`.
Option A (recommended) is the `recommended` subset when the report marks one, else `none`; never
"all". A recommendation never authorizes anything. An unclear reply is asked again. **Done when:**
the local selection is settled.

A live `worktrees` candidate is eligibility only: it is merged, clean and unlocked, which is not
evidence that nobody uses it. Ask for the owner's explicit confirmation that each selected worktree
is inactive, separate from the local selection; without it, drop that worktree.

For any remote branch in the fresh `remoteBranches` list, show its exact destructive action
`git push <remote> --delete <branch>`, which `.agents/quenching/bin/cq git prune --remote-branch` runs, and put it as its own decision on the sheet (`D2`, same recommendation rule). A remote branch is never
included in the local confirmation. **Done when:** the remote selection is settled and every selected
item has one explicit action.

### 3. Delete the chosen branches
```bash
.agents/quenching/bin/cq git prune --branch <branch> --id <id> --expect-tip <tip> --json
```
`<id>` and `<tip>` are the ones the manifest displayed. The verb re-reads the stale report and acts only on a branch it still lists at that tip (exit 2 otherwise, and a moved tip means a fresh run);
git refusing (`error: the branch '<branch>' is not fully merged`, exit 1) → report why and leave it standing;
this command never escalates to `-D`. **Done when:** every chosen branch is deleted, or its refusal
is reported.

### 4. Remove the chosen worktrees
```bash
.agents/quenching/bin/cq git prune --worktree <path> --id <id> --expect-tip <tip> --confirm-inactive --json
```
`--confirm-inactive` is passed only for a worktree the owner confirmed inactive. Orphan worktrees (directory missing) take neither flag. Worktree removal is **never --force**. A refusal (modified or untracked files inside) is reported with git's own
message, and that worktree is left standing. **Done when:** every chosen worktree is
removed, or its refusal is reported.

### 5. Delete the chosen remote branches
```bash
.agents/quenching/bin/cq git prune --remote-branch <branch> --remote <remote> --id <id> --expect-tip <tip> --json
```
Run this only for a selected item from the fresh `remoteBranches` list, after the separate remote
confirmation. The command is an external write: report its exact remote/branch and its output. A
refusal leaves the server branch standing; never retry with another command or infer success from a
local remote-tracking ref. **Done when:** every selected remote branch was deleted, or its refusal
was reported.

### 6. Report
State what was deleted, what was refused (and why), and what was left untouched because it was
never chosen. Separate local branches, remote branches, and worktrees in the report. **Done when:**
the three outcome classes are named.

## Invariants

- Never prune a branch or worktree `.agents/quenching/bin/cq git stale` did not report.
- Never offer `keptBranches` or `preserved` manifest entries for pruning: each is listed with the reason it stays.
- Never remove a live worktree without the owner's explicit inactivity confirmation, the displayed `id` and the approved tip.
- Never offer `unregisteredWorktrees` for pruning: `git worktree remove` does not act on an
  unregistered directory, and this class carries no action.
- Never delete a remote branch that `.agents/quenching/bin/cq git stale` did not report in `remoteBranches`.
- Use only the selected remote (`origin` when omitted); a branch reported by another remote is not
  a candidate for this run.
- Never pre-select "all" in the prune offer — every item is the human's own pick.
- Never fetch or run `git remote prune` implicitly; the report is the fresh fact this run acts on.
- Never `git branch -D`, `git push --force`, or `git worktree remove --force`; a refusal is
  reported and the target is left standing for that specific refusal.
