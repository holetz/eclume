---
description: "Take isolation for a piece of work: a worktree by default, unasked, stamped; a plain branch only when the human asks. Use for \"isolate this work\", \"cut a branch for this\", \"take a worktree\". Not for: pruning → /quenching-git-cleanup."
argument-hint: "[id-or-branch-name]"
allowed-tools: Bash(.agents/quenching/bin/cq git base:*), Bash(.agents/quenching/bin/cq git conventions:*), Bash(.agents/quenching/bin/cq git specs:*), Bash(.agents/quenching/bin/cq git state:*), Bash(.agents/quenching/bin/cq git worktree add:*), Bash(.agents/quenching/bin/cq specs config:*), Bash(.agents/quenching/bin/cq specs status:*), Bash(.agents/quenching/bin/cq components read:*), Read, AskUserQuestion
---

# /quenching-git-branch — take isolation before writing code

**Input**: `$ARGUMENTS` — optionally a spec id (stamps that spec's `branch:` record and its
`quenching-specs:` marking) or a short name for standalone work with no spec behind it. Omitted →
ask what the isolation is for.

Cuts a **worktree** before the first line of code — the form is the default and is taken unasked; a
plain branch in the current checkout only when the human asks for it. The mechanics — the names,
`worktreeSetup`, `sharedPaths` and the two records a taken isolation leaves behind — are owned by
[git/isolation.md](.agents/quenching/assets/references/git/isolation.md), cited below rather
than restated; this command is its standalone entry point for a caller with no build loop of its own.

**Grants.** `allowed-tools` holds only the `cq` verbs the `git-steward` also holds: the steward follows this body with its own `tools:` (it holds no `Skill`), so a call outside them here would leave its `branch` step blocked. A `worktreeSetup`, `git checkout -b` and the `.agents/quenching/bin/cq specs record` stamps go through the normal permission prompt.

## Workflow

### 1. Load the rules and the state in one read
```bash
.agents/quenching/bin/cq components read .agents/quenching/assets/references/git/isolation.md \
  --sections "§Isolation happens on the way into a build" --sections "§Branch and worktree names" \
  --sections "§Recording the isolation"
.agents/quenching/bin/cq components read .agents/quenching/assets/references/git/conventions.md \
  --sections "§The declared-directive layer" --sections "§The read-if-present rule"
.agents/quenching/bin/cq git conventions --json   # `config.branchName`, or absent
.agents/quenching/bin/cq git state --json           # `branch`, `status` (porcelain), `staged`, `remotes`
.agents/quenching/bin/cq git base --json
.agents/quenching/bin/cq specs config --json        # `worktreeSetup`, `sharedPaths`, or their empty values — exit 0 either way
```
`status` non-empty → refuse, name the offending paths, and stop; isolating a dirty
tree carries whatever was already sitting there into the first commit on the new ref, silently.
**Done when:** the rules are loaded, the tree is confirmed clean, and the base branch is resolved.

### 2. Resolve the ID, when one was given
`$ARGUMENTS` naming a spec → `.agents/quenching/bin/cq specs status --spec "<id>" --json` and read its `records.branch`.
Already stamped → report it (`base`, `work`) and **stop**; a second isolation for an already-isolated
spec is a no-op, not a fresh cut. No record → continue to the cut below, carrying the ID through
to step 4. `$ARGUMENTS` naming no spec (or empty) → continue with no ID; nothing gets stamped in
step 4, only the worktree itself. **Done when:** the ID (or its absence) and any
existing `branch:` record are resolved.

### 3. Take the worktree — only from the base, and with nothing to ask
If the current branch is already different from the resolved base, report that the checkout is
already isolated and carry it forward; do not cut a second branch or worktree. If it is the base,
the form is **Worktree**, unasked. State the base branch (from step 1), the branch name that will be
cut — `config.branchName` from step 1 governs it where declared, else the target's docs, else
`plan/<id>-<handle>` with an ID and a kebab-case name derived from `$ARGUMENTS` or asked for without
one — and the worktree path, with its cost in the same block: a fresh checkout carries only what
git tracks — no installed dependencies, no `.env`, no venv, no build output. `worktreeSetup`
non-null is displayed **verbatim** there and runs as part of the cut; `sharedPaths` non-empty is
displayed verbatim too. There is no decision sheet on the form.

**A plain branch is the human's override, and only theirs.** When the request says so in its own
words — "no worktree", "just a branch", "use this checkout" — run `git checkout -b <branch>` in this
checkout instead, and skip the setup: there is no new tree to prepare. Never offer the two as a
choice, never pick Branch because the target looks awkward, and never fall back to it after a
`git worktree add` failure: a failed cut is reported verbatim and the run stops, because a silent
branch would leave the build in the main checkout. **Done when:** the form is resolved — Worktree by
default, Branch only on an explicit request — or the run stops on a git error.

### 4. Cut it, run the setup, and stamp
Run the worktree cut; a failure (name taken, dirty path, locked worktree) is
reported verbatim and nothing is stamped. **The cut starts from the remote base**, because
a PR merged through `gh` moves no local ref and the local `<base>` may miss the dependency the run
waited on:
```bash
.agents/quenching/bin/cq git worktree add --path <path> --branch <branch> --base <base> [--spec "<id>"] --json
```
With an ID from step 2, pass `--spec`: the verb refuses (exit 2, nothing cut) a spec that does not
exist or does not own `<branch>`, and after the cut stamps the `branch:` record itself
(`branchRecord` in the payload; a failed stamp is exit 1 and leaves the worktree). The verb fetches `origin <base>`, cuts `<branch>` from the fetched tip resolved to a commit — so
the branch has no upstream and a push without an explicit destination never targets the base —
and links the declared shared paths inside the new worktree. A fetch error is exit 2 and stops the
run; only a missing `origin` falls back to the local `<base>` (`fromRemote: false`, the
`NO-REMOTE` line), and the report says so. A link failure is exit 1 with `linkRefusal`: it does not
undo the worktree, and it stops this flow before running `worktreeSetup`. When the
link succeeds, run a declared `worktreeSetup` once with cwd inside the new worktree; a failing
setup does not undo the worktree — report both facts separately. **A worktree outside the project
directory is not the shell's cwd:** the harness may return the cwd to the base checkout after every
command, so from here on each command carries the worktree explicitly — `cd <worktree> && …` in
the same call, `git -C <worktree>`, `.agents/quenching/bin/cq --root <worktree>` — or a cwd-dependent tool (`cq` without
`--root`, `git diff`, tests) reads the base checkout and reports green over a tree that did not
change. `.agents/quenching/bin/cq git …` takes no `--root` on its write verbs
(a usage error): it always runs as `cd <worktree> && .agents/quenching/bin/cq git …`. Then, only with an ID from step 2
(the Worktree form already stamped `branch:` through `--spec`; **Branch** form stamps it by hand):
```bash
.agents/quenching/bin/cq specs record "<id>" branch --set base=<base> --set work=<branch>   # Branch form only
.agents/quenching/bin/cq git specs <branch> --add "<id>" --json
```
**Done when:** the worktree (or the requested branch) exists on disk, the setup ran and was reported
(worktree only), and — with an ID — `branch:` and the `quenching-specs:` marking are stamped.

### 5. Report
State the form taken, the branch name and **which layer governed it**, the worktree path, the setup's
result (if run), and what was stamped. **Done when:** the summary names every fact step 4 produced.

## Invariants

- Never isolate over a dirty tree — refuse and name the paths.
- **Take a worktree by default, unasked.** No decision sheet on the form, no offer, and no sniffing
  the target repo to pick something else; a plain branch only when the human asks for it in the
  run's own words.
- Never fall back to a branch or the base after a failed `git worktree add` — report the failure and
  stop.
- Never leave the work on the base — no form of the isolation commits there.
- Stamp `branch:` only once per id — a record already present is read, never overwritten.
- Never install `docs/standards/git/**` into the target, and never write `gitConventions` into its
  `.agents/quenching.json`; a repo's own conventions are read, never written, by this command.
