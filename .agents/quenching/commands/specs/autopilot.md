---
description: "Run ONE improvement round (triage, map, epic, orchestrate, review, gate); `--until-dry` or `--until` repeat rounds until a dry queue or a deadline. Use for \"run the autopilot until 7am\". Not for: ONE epic → /quenching-specs-orchestrate; owner-decided map → /quenching-specs-improve."
disable-model-invocation: true
argument-hint: "[--until <ISO-8601 date-time with offset>] [--until-dry] [--max-launches <n>] [--max-tree-tokens <n>] [focus areas]"
allowed-tools: Bash(.agents/quenching/bin/cq:*), Bash(.agents/quenching/bin/cq.cmd:*), Bash(git:*), Bash, Read, Grep, Glob, Agent, Task, TaskStop
---

# /quenching-specs-autopilot — one round of improvement; more only on request

**Input**: `$ARGUMENTS` — no flag runs **ONE round** (steps 1–8) and stops. `--until-dry` repeats
rounds until the queue runs dry; `--until <date-time with offset>` (e.g. `2026-10-09T07:00-03:00`)
repeats them until the deadline (and still stops at a dry queue). `--max-launches <n>` sets the
launch ceiling; without it the ceiling is `shared.autonomy.maxLaunches` from `.agents/quenching/bin/cq config show --effective --json`
(default **40**, provisional: it is fixed only after the human reads the measurement of the last three runs), and the flag wins over the key. `--max-tree-tokens <n>` sets an opt-in ceiling on the tokens measured per
model across the tree, with **no default**: without it nothing is read or compared. Optionally focus areas as in `/quenching-specs-improve`.
Typed by the human only: **the invocation is the human's delegation** for the whole run — every
forced execution, push, PR and merge below is authorized by it, and by nothing else.

This session is the **conductor**. It decides as the owner's delegate, keeps only summaries, and
never builds: reading, mapping, decomposing, building and reviewing are agents
(`quenching-scout`, `quenching-spec-architect` for real decomposition only, `quenching-orchestrator` or, in economy mode, the spec-runner/verifier/git-steward trio, and the read-only opus
`quenching-reviewer`, which this conductor launches at step 6). The orchestrator's protocol (waves, workers, verifier, acceptance) lives in
`plugins/quenching/agents/orchestrator.md`; do not restate it.

**Why `Bash` is unrestricted here.** Step 1 and step 7 run the gate the target's root harness
declares in its operating section (`AGENTS.md`; legacy `AGENTS.md`), whose command no fixed grant can name. No other
non-`cq`, non-`git` command is run.

## Invariants

- **Never forced.** A decision that **widens** a grant or a surface that executes code (hooks,
  scripts, CI, `allowed-tools`, an agent's `tools:`), or that chooses between designs of this
  autonomous protocol itself, is never taken by the conductor. It goes to the run's epic
  "decide with the human" — one per run, created on first need — and the round continues without
  it. **Narrowing** a grant is not widening it.
- **Relevance over activity.** A spec enters the run only with evidence (`path:line`, a command's
  output, a measurement) and a concrete consequence — the bar of `/quenching-specs-improve`. "Nothing
  left to polish" is never a reason to invent work.
- **Findings become specs, never hot fixes.** What the correctness review finds is a spec of the
  next round; the conductor never patches `main` itself.
- **Liveness.** A worker with no activity for more than **20 min** (its transcript's mtime) and no
  live child process is stopped with `TaskStop` and relaunched **once**. `shared.autonomy.livenessMinutes` replaces the 20 minutes when set. A second stall goes to the
  final report, never a third launch.
- **Git is read-only for every agent this session briefs, except the orchestrator's workers.**
  Each brief forbids `git stash`, `checkout`, `switch`, `reset`, `restore`, `rebase`, `clean`,
  `commit --amend` and force-push. After every agent returns, audit `git status --short`,
  `git stash list` and `git worktree list`; any change is reported, never silently reverted.
- **Cost.** At most 3 workers at a time; each brief ≤ 1,500 characters, each return ≤ 800 words.
  Wait for completion notifications instead of polling. One correctness review per epic, never per
  spec. The conductor reads summaries, never diffs or file dumps. The Codex review of step 6 is one
  call per epic and its tokens are reported, or `not measured`.
- **The launch ceiling binds the whole tree.** Every `Agent`/`Task` launched in the run counts —
  children, grandchildren reported by returns, Liveness relaunches and follow-ups — in the
  `launches` field of the round record. Before each launch the conductor compares it with
  `--max-launches`; at the ceiling it admits nothing more, writes the record (`open`, next step)
  and reports `continue`. The count covers what the conductor and the returned reports show; what
  is in flight is declared `not measured`.
- **The tree-token ceiling is opt-in and per model.** Only with `--max-tree-tokens <n>`, before each
  launch the conductor reads `.agents/quenching/bin/cq components session cost --json` (its default is the most recent session for this cwd, the conductor's own) and
  compares, per model, the measured tokens (`input + cacheRead + cacheWrite + output` of that
  model's `byModel` row) with `<n>`, never summing tiers. A model already at the ceiling, or with no
  margin (its measured total plus the largest measured total of a single agent of that model in the
  tree reaches `<n>`; with no agent measured, only the raw ceiling counts), admits nothing more: the
  conductor writes the record (`open`, next step) and reports `continue`. What is in flight or
  unmeasured is declared, never estimated.
- **A `budget:` continue is relaunched, not retried.** When the orchestrator returns `continue`
  with `NOTE: budget: …`, the conductor launches it again in a fresh context on the same epic. The
  relaunch counts in `launches` and is not a failure, but needs progress: at least one more spec
  `done` or `merged` than at the previous return. Without progress the epic goes to the report as
  `needs-human`.
- **The round record is resumable.** Each round writes `<ephemeral area>/autopilot/<date>/rounds.md`
  (one block per round: number, start ref, epic, specs placed, `launches`, next step,
  `open|closed`) at the end of every step 1–7. A round that returns `continue` stays `open`.
- **The deadline binds launches.** With `--until`, no worker starts if it cannot finish before the
  deadline; what is in flight at the deadline is reported `continue` with its state.

## Workflow

### 1. Health
Resolve `cq` per [align/tool-resolution.md](.agents/quenching/assets/references/align/tool-resolution.md)
§Resolving the tool; branch on the exit code. Read the root harness for the gate command and the
ephemeral area. Check, on `main`: the checkout is clean (`git status --short`), `git stash list` is
empty, `git worktree list` holds only this run's worktrees, and the gate is green. Anything red →
this round's first spec is fixing it (`.agents/quenching/bin/cq specs new`, then steps 4–5 on it alone). Then run
`.agents/quenching/bin/cq git preflight --json` once (covered by the existing `Bash(cq:*)`; no new grant) and write its
five checks (`store`, `types`, `push`, `ghAuth`, `ci`) in the round block as `preflight:`. `store`,
`push` or `ghAuth` in `fail` → fixing it is this round's first spec, like a red gate. `mergesAllowed:
false` (CI unavailable) → steps 4–5 plan no merges and no chain that depends on a merge, and the
report says why. Hooks are never disabled and `--no-verify` is never passed. Read the
round record first: an `open` round whose start ref is still reachable from `main` resumes at its
recorded next step and keeps its `launches`; any other record opens a new round. Record the
round's start ref: `git rev-parse main`.
**Done when:** `main` is clean and green, or the fix is this round's first spec.

### 2. Queue
List the loose specs — open, in no epic — with `.agents/quenching/bin/cq specs list --lean --json`, and the store's
errors with `.agents/quenching/bin/cq specs validate`. Before any of them enters, one `quenching-scout` per batch proves
it is still relevant against the current code:

- the surface it describes has changed → record the evidence in `## Outcome`
  (`.agents/quenching/bin/cq specs section <id> Outcome --write`) and `.agents/quenching/bin/cq specs promote <id> --outcome abandoned`;
- it needs the human (the **never forced** list) → `.agents/quenching/bin/cq specs link add <human-composite> <id>`;
- otherwise it joins this round's queue.

**Done when:** every loose spec is queued, abandoned with evidence, or in the human epic.

### 3. Map
Only when the queue is short (fewer than three specs): run the mapping of
`/quenching-specs-improve` steps 1–3 — read-only `quenching-scout` agents per area, evidence plus
consequence, no duplicate of an open spec, at most 15 candidates, every `high` re-checked — with
this session deciding the owner's questions as the delegated owner, except those on the
**never forced** list, which go to the human epic. Focus areas from `$ARGUMENTS` narrow the areas.
The map is ephemeral, under `<ephemeral area>/autopilot/<date>/`.
**Done when:** the candidates kept are listed with evidence, or the map found none.

### 4. Composition
**Mechanical capture, by default.** When the queue and the kept candidates already decide the
members (title, `complexity`, dependencies), this session creates the composite and the members
itself, with no `quenching-spec-architect`: search by title in `.agents/quenching/bin/cq specs list --json` first
(a match is reused), then `.agents/quenching/bin/cq specs new "<title>" --complexity <level> </dev/null` per member and
`.agents/quenching/bin/cq specs link add <composite> <spec> --group "<wave>" --after <labels>` (labels `S<n>` returned by
earlier `link add` calls), serializing any two members that touch the same files with `after:`.
Exit 2 is read, never repeated blindly. The model restrictions on code and classification stay as
they are.
**Decomposition, by the architect.** `quenching-spec-architect` is launched only for real
decomposition: members not yet decided, a spec over the worker budget (`proposal-only`), or waves
that need reading file overlap. Hand it the queue and the kept candidates; it creates the composite
and the members.
Either way, write the composite's `## Design` with `.agents/quenching/bin/cq specs section <composite> Design --write`,
carrying the **autonomy policy**: forced execution, push, PR and merge of every member after a
verifier PASS, authorized by this invocation, with its date. Check the result with
`.agents/quenching/bin/cq specs status --epic <composite>` and `.agents/quenching/bin/cq specs validate`.
**Done when:** the composite exists with its waves, its `## Design` carries the dated policy, and
`validate` raises no `sp-link-*` finding.

### 5. Orchestrate
**Economy mode.** An epic with **at most 2 members, every one `low` or `medium`**, runs without
`quenching-orchestrator`: this session launches `quenching-spec-runner` →
`quenching-verifier` → `quenching-git-steward` for each member, with the acceptance rules
of the orchestrator's protocol, cited and not restated — steps 3 (budget, `budget:` relaunch), 4
(acceptance only on a verifier PASS, the `execute-done:`/`conclude` two spawns, `publish` by the
steward, one re-spawn) and 5 (retry, idempotency) of `plugins/quenching/agents/orchestrator.md`.
Each prompt is ≤ 1,500 characters and carries the word `autonomous`, the model passed explicitly and
the sentence "No git stash, checkout or reset; work only in your worktree." Two members with a
dependency run in series; without one, in parallel (never more than 3 workers). Every launch counts
in `launches`, and the ceilings of the invariants above bind it. No new grant: this session already
holds `Agent` and `Task`.
**Otherwise** (3 or more members, or any `high`/`xhigh`), start `quenching-orchestrator` on
the epic with the word `autonomous`, the base branch and the deadline (≤ 1,500 characters).
Apply **Liveness** to every worker, in either mode. A spec returned `blocked` with a `needs-human:`
note moves to the human epic; `failed` or `continue` is carried to the report with its note, never
retried in this round; a `continue` whose note starts with `budget:` is the exception, relaunched as
the invariant above says.
**Done when:** every member is `done` or placed (economy mode), or the orchestrator returned its
fixed report and every non-`done` spec is placed.

### 6. Correctness review
After every epic that changed code, start `quenching-reviewer` once (`model: opus`) over the epic's
merges (`git log --merges <round start>..main`); the orchestrator does not launch it. It is
read-only, and the gate is the only thing it executes. It reports only findings it **reproduced** —
a command, its output, the `path:line` — never style, and a security review of the same range when
the epic touched a grant, a hook or anything that executes. That review hunts the widening a worker
makes by mistake, never deliberate evasion of the audit (symlink, BOM, line separators, a diff
driver in `.git/config`): the audit is no sandbox. Never a second review of the same range.

**Codex, in parallel.** Right after launching the reviewer, run `cq codex probe --json`. Exit 0 or 2
→ write a prompt file under `<ephemeral area>/autopilot/<date>/` (the range, one line per finding as
`path:line — what — why`, no style) and run `cq codex review --worktree <checkout> --prompt <file>
--run <name> --json` while the reviewer works. The reviewer gets no Codex grant;
the conductor alone calls `cq codex`. Exit 1 of the probe, or exit 1 or a timeout of the review →
no Codex findings: the final report names the fallback and its reason, and the step goes on with the
Claude review alone; a refusal (exit 2) is reported the same way and never blocks the step. The one
exception is exit 2 `codex-git-guard`: the review changed the tree, so stop the round and hand it to
the human naming the payload's `changed` and `guard.moved` — never clean them.

**Consolidate by `path:line`.** Merge both lists, one entry per `path:line`, marked claude,
codex or both. A finding the reviewer reproduced stands. A `codex`-only finding becomes a spec
only once reproduced — by the reviewer or by the conductor, with the command and its output; the
payload's `findingsNeedReproduction` binds.
Unreproduced ones are dropped and counted in the report. Keep the Codex tokens from the payload, or
`not measured`. Each finding kept becomes a loose spec (`.agents/quenching/bin/cq specs new`, then its `## Problem` with
the reproduction), queued for the next round; `NONE` creates none.
**Done when:** the review returned (and Codex returned or fell back, reported) and each reproduced
finding is a spec.

### 7. Gate and audit
On `main`: pull, run the gate, and the audit of step 1. Red → the first spec of the next round.
Then decide whether to stop:

- **deadline** — `--until` is reached, or no worker of a next round could finish before it;
- **dry queue** — a whole round in which the queue (step 2), the map (step 3) and the review
  (step 6) produced **no** spec with evidence and consequence.

Neither → without `--until-dry`/`--until`, close the round record (`closed`), print step 8 and
**stop: one round is the default**. With either flag, close the record and open the next round in a
**fresh context**: launch one sub-agent that follows this body from step 1 with the record as its
only input (counted as a launch). If a sub-agent cannot launch sub-agents, stop instead, with the
record `closed` and the next step printed as the invocation to resume in a new session
(`/quenching-specs-autopilot --until-dry`).
**Done when:** the gate and the audit were read, and the run either stops or starts the next round
the flags asked for.

### 8. Final report
Print: the launches used against `--max-launches`; per epic, the merged specs with their PRs; the human epic and its members; every decision
this session took as the delegated owner; specs in flight at the deadline, as `continue` with their
state; second stalls; and the tokens the run spent per model and agent type, read with
`.agents/quenching/bin/cq components session cost` and never summed across tiers; plus the Codex review of each epic —
ran or fallback with its reason, findings by origin, dropped unreproduced count, and its tokens or
`not measured`, kept apart from the Claude tiers.
**Done when:** the report is printed.
