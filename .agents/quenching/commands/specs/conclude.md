---
description: "Close ONE spec out: review the branch, write knowledge, archive, prove the gate, hand off to a PR or merge. Use for \"conclude this spec\", \"close it out\", \"abandon this spec\". Not for: building → /quenching-specs-execute."
argument-hint: "[id] [--outcome done|abandoned]"
allowed-tools: Bash(.agents/quenching/bin/cq:*), Bash(.agents/quenching/bin/cq.cmd:*), Bash, Read, Glob, Grep, Write, Edit, AskUserQuestion, Skill
model: opus
---

# /quenching-specs-conclude — review, archive, distil — and hand off

**Input**: `$ARGUMENTS` — the spec id, and optionally its outcome. A conductor launched with
`--autonomous` adds the word `autonomous`; the run then stops at the named PR handoff, which the `git-steward` performs.

Closes ONE spec out, short of the merge itself. Four things happen, in this order, and each is a
separate decision: the whole branch is **reviewed**, the `/docs/` the work *revealed* is
**written**, the spec is **archived and distilled** into the OKF bundle, and the pre-merge gate is
**proven green** — then the run **stops**, naming `/quenching-git-pr-create` or
`/quenching-git-merge` as the human's own next command — except that `low` gear chains directly
to `/quenching-git-pr-create` through `Skill` after the green gate, unless the input carried `autonomous`.

**Done work ends on the work branch; abandoned close-out writes land in the checkout holding the
base.**

The distillation doctrine — what crosses into `/docs/`, what stays, and how it is graded — lives in
[specs-conclude/distill.md](.agents/quenching/assets/references/specs-conclude/distill.md)
§What crosses, what stays. Every hand-off into another module's command (`/quenching-align:*`
for the bundle) runs only where that module is enabled, per
[tool-resolution.md](.agents/quenching/assets/references/align/tool-resolution.md) §Routing into
another module; with `quenching-specs` alone, the distillation still writes through the shipped
insert procedure and only the offers into `quenching-align` drop. The layout and the gates live in
[specs-develop/spec-driven.md](.agents/quenching/assets/references/specs-develop/spec-driven.md)
§The spec document §The gates and the stage-scoped explicit-none rule. The `.agents/quenching/bin/cq specs`
surface lives in
[specs-surface.md](.agents/quenching/assets/references/specs-develop/specs-surface.md)
§The `.agents/quenching/bin/cq specs` tool surface; the report shape lives in
[report-mold.md](.agents/quenching/assets/references/specs-develop/report-mold.md)
§The report mold.
## Resolving the tool

Resolve `.agents/quenching/bin/cq specs` per
[align/tool-resolution.md](.agents/quenching/assets/references/align/tool-resolution.md)
§Resolving the tool. Branch on the **exit code** (0 ok · 1 findings · 2 refusal) and the `--json`,
never on prose.

## Doctrine

- **The outcome is stated, never inferred.** `done` and `abandoned` are opposite claims about the
  same file, and nothing — not task progress, not staleness, not a sweep — may decide which was
  meant. If the human has not said, ask — under `autonomous`, refuse instead (§Under `autonomous`).
- **Concluding as `done` refuses to lie.** Open `- [ ]` boxes with `--outcome done` is exit 2 with
  the list. `--force` exists for the case where the human knows why — the work was descoped, or
  proven elsewhere — and says so.
- **Abandoning is always allowed.** `--outcome abandoned` never refuses and never needs `--force`.
- **`done` distils; `abandoned` does not.** Concluding as done mints by-products into `/docs/` as
  knowledge the product **adopted**. An abandoned spec harvests at most what was learned by *not*
  building it, as
  `authority: background`; a decision it *would* have made never crosses.
- **An abandoned spec's branch is offered for deletion, never handed off toward a merge.** Partial
  work on a branch nobody adopted is history, not a change; offer to keep it or delete it, and
  default to keeping. This is the one branch-disposal decision that stays inline here rather than
  in `/quenching-git-cleanup`.
- **Everything `abandoned` writes lands in the checkout holding `<base>`, never this branch** — see
  [specs-conclude/abandoned.md](.agents/quenching/assets/references/specs-conclude/abandoned.md)
  §Locating the checkout and writing into it §The branch-delete offer, informed rather than defensive.
- **Declared rules were already written.** The `/docs/standards/` a task explicitly named went in
  during execution, honestly graded. What lands here is what the work *revealed*.
- **What a standard attaches to the *merge* is settled at step 5, not built as a task** — a version
  bump, a changelog entry, a manifest re-stamp.

## Resuming

Read this before deciding what to run. Each stage has one durable signal, and a stage whose signal
is already set is **reported and skipped**, not repeated:

| Stage | Signal it already ran | On resume |
| --- | --- | --- |
| review | `reviewed: {date}` in frontmatter | skip; offer a re-read only if the diff grew since |
| emergent `/docs/` | it rides with the review — same stage, same commit | skipped with the review |
| archive | the file is in `archive/` with `outcome:` stamped | skip the move; go to distil |
| distil | no record — it is offered once per conclude | offer it; an empty harvest is a valid answer |
| release obligations | the branch diff already carries what the standard requires | report it satisfied; re-read the standard only if the diff grew |
| validation gate | no record — it is a verdict on the tree as it stands *now* | always re-run it; a green run from before the last commit proves nothing |
| already merged | `git branch --merged <base>` lists the work branch, or a `merge`/`pr` record already exists | report that a later `/quenching-git-merge` or `/quenching-git-pr-create` run already finished this — there is nothing left to hand off |

`reviewed` is `writeOnce: false`: a diff read again is a new fact. `outcome` is `writeOnce: true` —
if it is already set and reality disagrees, that is a **finding to report**, never a value to
overwrite. `merge` and `pr` are read only to answer the "already merged" row above, and for
`abandoned` from the base checkout (Doctrine).

## Under `autonomous`

A run whose input carries `autonomous` has no human and no decision sheet: it asks nothing.
Every point where this command would ask takes the one answer below — the narrowest that lets the
step run — and nothing outside this table is granted. A case the table sends to `needs-human`
stops the run with `STATE: blocked` and `NOTE: needs-human: <the question>`.

| Where it would ask | The answer under `autonomous` |
| --- | --- |
| Step 1 — the outcome | taken **only** from the input's `--outcome`; absent → `needs-human`. `autonomous` never supplies an outcome |
| Step 1 — which spec (several marked ids, or no marking) | `needs-human` |
| Step 1 — open tasks under `done` | `needs-human`; never `--force`, never a switch to `abandoned` |
| Step 2 — the Codex review | no question exists: probe, review and fallback run as written; a Codex-only finding not reproduced goes to the report, never to a fix |
| Step 3 — the emergent `/docs/` plan | `done`: the narrated plan is applied on the work branch, unconfirmed — the PR is its human review. `abandoned`: declined; the candidates are named in the report |
| Step 4 — the `## Outcome` draft | written unconfirmed; an exit 2 from `promote` → `needs-human` with the refusal quoted, never `--force` |
| Step 5 — the distillation plan | as step 3: applied on the work branch for `done`, declined and named for `abandoned` |
| Step 5 — the release obligations | `done`: applied on the work branch as narrated, the standard quoted in the report |
| Step 6 — branch behind its base | the base merged in (`git merge --no-edit origin/<base>`, never a rebase), then the gate; a conflict outside the generated mirrors → `git merge --abort` and `needs-human` with the paths |
| Step 6 — an inconclusive check | `needs-human`, the check named |
| Step 6 — the abandoned branch-delete offer | keep, recorded in the report |

A red gate is `STATE: failed`, never a question. The PR handoff is named and not invoked (step 6).

## Workflow

### 1. Resolve the spec, the outcome, and what already happened
An ID in the input → use it. **No ID given → try auto-discovery first**, off the current
branch's own marking:
[auto-discover.md](.agents/quenching/assets/references/specs-conclude/auto-discover.md)
§Reading the marking §Filtering to valid IDs §Resolving what remains, cited rather than
restated. One valid id resolves it silently, naming the marking as the source; more than one asks
which, on a decision sheet. No valid marking → §The fallback there measures the diff and always
asks whether to materialize a minimal spec — accepted, its new id is used from here on exactly
like a marked one. **Declined, headless completion — closing with no spec file at all — is not
built**: say so, record it with `.agents/quenching/bin/cq specs discover`, and fall back to `.agents/quenching/bin/cq specs list --json` and
ask. Establish the outcome — **ask if it was not stated**, on a
decision sheet: *done* (it shipped) or *abandoned* (it will not be built). Under `autonomous`,
every question of this run is answered by §Under `autonomous`; elsewhere a sub-agent does not ask:
return `STATE: blocked` with `NOTE: needs-human:` carrying the decision sheet.
```bash
.agents/quenching/bin/cq specs status --spec "<id>" --json
```
Read task progress, the `## Outcome` state, and the records — `branch`, `reviewed`, `merge`, `pr`,
`outcome` — from that payload. Then, for the `## Discoveries` lines themselves, the one body this
step needs: `.agents/quenching/bin/cq specs section "<id>" Discoveries --json`. Then read git: the
current branch, whether the work branch exists, and whether it is already merged. Announce the
outcome and, per §Resuming, which stages this run will actually perform.

Open tasks under a `done` outcome are surfaced **now**, before anything is written, so the human
can choose between finishing them, forcing, or switching to `abandoned`.
**Done when:** one spec, one outcome, and the list of stages still to run are all settled.

### 2. Review the whole branch diff
```bash
git diff origin/<base>...HEAD   # <base> is the branch record's `base`; NO-REMOTE: git diff <base>...HEAD
```
Against `origin/<base>` because a PR merged through `gh` moves no local ref (step 6 fetches it); the
three-dot form keeps the diff to this spec even when the remote base advanced after the cut. This reads
the whole change for **coherence**, beyond execute's per-task self-review — two tasks that solved the same problem differently, an abstraction that wanted
extracting once the third caller appeared, a `## Impact` path nothing ever wrote, a standard the
diff contradicts.

**Independent Codex review, in parallel, by default when there is quota.** Before reading, run
`cq codex probe --json`: exit 0 (available) or 2 (unknown) → write the prompt (the diff range
`origin/<base>...HEAD`, asking for findings as `path:line` with severity) to
`.quenching/codex/<run>-prompt.md` and run, in the background,
`cq codex review --worktree <work checkout> --prompt <that file> --run <run> --json` (NO-REMOTE: the local `<base>` in the prompt)
while you read the diff yourself. Exit 1 from the probe, a timeout or any failure of the review →
**fallback**: the Claude review stands alone and the report says `Codex: fallback (<reason>)`; it is
never a conclude error and never blocks `reviewed`. Consolidate both lists by `path:line`: a finding
both reviewers share counts; one **only Codex** raised counts only once reproduced (by your own
reading, or by a command whose output you quote), otherwise it is reported as unreproduced and
never becomes a fix. Codex must change nothing: exit 2 `codex-git-guard` means it did, so stop
conclude and hand the tree to the human naming the payload's `changed` and `guard.moved` — never
clean them. Its output is never applied unread. A Codex-surface run
skips this paragraph (no nested Codex).

Present the findings. Fixes go in as ordinary commits on the branch, before the merge. Then stamp
the record — `.agents/quenching/bin/cq specs record "<id>" reviewed --set date=<today>`, never by editing the
frontmatter.

**The test is `branch.work != branch.base`, never the record's presence** — in-place work stamps
one too (`/docs/standards/workflows/plan-git-record.md` §Three frontmatter records carry the
underivable git facts). No record, `work` equal to `base`, or no git → say so and skip to step 4;
there is no branch diff to read.
**Done when:** the diff was read and `reviewed` is stamped, or the run recorded why there was
nothing to review.

### 3. Write the `/docs/` the work revealed
The `/docs/standards/` a task explicitly named is already in — execute wrote it as part of that
task. What lands **here** is what the work revealed and nobody declared: the `## Discoveries` lines
worth a doc, and whatever the branch review just surfaced.

Decide what crosses with the table in
[distill.md](.agents/quenching/assets/references/specs-conclude/distill.md)
§What crosses, what stays; write each through the insert procedure in
[knowledge-add/homes.md](.agents/quenching/assets/references/knowledge-add/homes.md)
§The frontmatter stamp §Updating `index.md` §Enriching the glossary §Self-check, stamping
`authority` honestly. Present them as ONE plan and take one confirmation (under `autonomous`,
§Under `autonomous` answers it).

These land on the branch, in their own commit — or, for `abandoned`, the base checkout (Doctrine).
A `## Discoveries` line that gets a doc is resolved in place. No OKF bundle → skip silently.
**Done when:** the emergent docs are written and committed, or the offer was declined, or there is
no bundle.

### 4. Write `## Outcome` and archive
**First preserve observed build cost, with provenance.** This is independent of the derived
`.agents/quenching/bin/cq specs estimate` reading heuristic. Inspect `records.buildCost` from step 1: a valid measured
record already covers the build and survives a resumed conclude; do not replace it with missing
telemetry. New evidence may replace `unavailable`, with every field written together so an old
reason or measurement cannot survive the re-stamp. An abandoned, unbuilt spec also reports
unavailable rather than inventing an execute cost.

Use the existing meter **only** when the briefing identifies an explicit **build-only** Claude
Code subagents directory and the agent ids belonging to this spec's execute runs:

```bash
.agents/quenching/bin/cq components session cost "<explicit-build-only-subagents-directory>" --json
```

**Never infer** that scope from the latest session, the source spec's branch, transcript mtime,
prompt prose or a directory containing unrelated workers. Missing/ambiguous scope, native **Codex**
usage that was not measured, a meter refusal, missing requests or parse findings are unavailable;
exit 1 is partial evidence, never silently a complete measurement. Preserve the reason and scope
in the report. Do not invent usage from context capacity, file sizes or model memory.

On exit 0 with exact attribution and known models, retain the meter's `byModel` totals **per model**:
`model`, `requests`, `input`, `cacheRead`, `cacheWrite`, `output`. For each model, add
`maxRequestExposureTokens` as the maximum `groups[].maxWindow` for that model. That existing
meter field is reported request exposure, **never a context peak**: executor iterations can
aggregate in top-level usage. State that limitation in `source`; no iteration-peak coverage is
claimed. Keep the array compact as one JSON scalar, with no sum across tiers and no monetary cost.
Set `source` to runtime, explicit directory/agent ids, measurement command/exit and coverage;
`measurements` contains only observed values, and `reason` is empty. An unknown model/agent
attribution does not justify a measured whole-build claim.

Write the conclude-owned record **before archive**, through the generic record writer:

```bash
.agents/quenching/bin/cq specs record "<id>" buildCost --set status=measured --set date=<today> \
  --set "source=<runtime; exact build scope; command/exit; request-exposure limitation>" \
  --set 'measurements=<compact per-model JSON array from the observed payload>' --set 'reason='
```

For unavailable evidence write no numeric stand-in; an empty scalar is absence, not zero:

```bash
.agents/quenching/bin/cq specs record "<id>" buildCost --set status=unavailable --set date=<today> \
  --set "source=<runtime and any explicitly known scope>" --set 'measurements=' \
  --set "reason=<why the build was not measured>"
```

Read the write's exit code; retry a transport failure with backoff, and read an exit-2 refusal
without repeating it blindly. A failed write stops this step before archive. Report the record's
status, provenance, per-model values or unavailable reason; calibration is future evidence work,
not an inference this conclude makes.

`## Outcome` is the archive gate — the spec cannot move without it. Draft it, confirm it (under `autonomous`, §Under `autonomous`), write it:
```bash
.agents/quenching/bin/cq specs section "<id>" Outcome --write     # body on stdin
.agents/quenching/bin/cq specs promote "<id>" --to archive --outcome done|abandoned [--force]
```
For `done`: what shipped, what was left out, what the next reader needs — **reviewed, distilled,
ready for merge**; name neither a merge strategy nor a PR. For `abandoned`: the reason it will not be built is the
whole content.

A refusal (exit 2) lists exactly what is missing or which boxes are open — surface it verbatim and
let the human decide; **never pass `--force` on your own initiative.** Commit the move on the
branch — or, for `abandoned`, computed here but committed into the base checkout (Doctrine).
**Done when:** the file is in `archive/` with its `outcome:` stamped and committed, or the run
stopped at a refusal the human declined to override.

### 5. Distil, and settle the release obligations
This is the last writing step, and everything it writes lands on the **work branch** for `done` — or, for
`abandoned`, the base checkout (Doctrine above). Two things happen here, in this order.

**First, the distillation pass** — the single bridge into `/docs/`, per
[distill.md](.agents/quenching/assets/references/specs-conclude/distill.md)
§The procedure (one confirmation), **branching on the outcome**:

- **`done`** — the full pass over what is *left*: a decision still sitting in `## Design`, a generic
  understanding, a term the spec coined, a follow-up worth its own spec. Most of the harvest was
  already written in step 3 or during execution; **zero to a few is the normal result**.
- **`abandoned`** — **only** a narrow harvest of what was learned by not building it, as
  `authority: background`. Never mint a decision the spec *would* have made. Most abandonments
  distil nothing, and that is the correct result.

One plan, one OK (under `autonomous`, §Under `autonomous` gives it). Every write goes through
[knowledge-add/homes.md](.agents/quenching/assets/references/knowledge-add/homes.md)
§The frontmatter stamp §Updating `index.md` §Enriching the glossary §Self-check. No bundle → skip
silently, landing per Doctrine: the work branch for `done`, the base checkout for `abandoned`.

**Then settle the release obligations the repo's standards attach to the merge itself.** With an
OKF bundle present, derive which standards the branch diff's own paths answer to — an aggregate in
the shell, never a walk of `/docs/standards/<subject>/` — and read exactly those, per
[align/evidence-doctrine.md](.agents/quenching/assets/references/align/evidence-doctrine.md)
§1 §2. Apply what they require *of the merge* rather than of any one task — a version bumped across
artifacts a standard says must move together, a changelog entry, a manifest re-stamped. This is the
only correct moment for it: the whole branch is written, so what the release *is* is knowable.

Nothing is invented. A repo whose standards attach nothing to a merge gets nothing, silently, and
so does a repo with no bundle. What a standard *does* require is presented as ONE plan with the
standard quoted, taken on one confirmation (or §Under `autonomous`), and committed on the branch. A requirement the diff
already satisfies is reported as already done, never redone.

For `abandoned`, **no release obligation is settled** — a version nobody adopted is a claim the
history should not carry. The distillation above still runs.
**Done when:** the distillation offer was made and applied or declined, and the release obligations
were applied, reported as already satisfied, or reported as none.

### 6. Prove the gate green, then hand off
Nothing after this point writes anything — the last commit this run makes is step 5's.

**First the gate: re-run whatever the repo's `## Validation` names — on the WORK BRANCH, before
merging.** Run it from the checkout that carries the work (the worktree or branch this run is
standing on), so what it grades is the change being proposed.

**A failing check stops the handoff.** Report which check failed and what it printed, leave the
branch unmerged, and let the human fix it *on the branch* — then this command is re-run. Never hand
off past a red check, and never repair one with a commit that isn't the fix itself.

**The gate grades the branch, so the branch must already carry the base.** If the base moved since
the branch was cut, a green gate says nothing about the merged tree:

```bash
if git remote get-url origin >/dev/null 2>&1; then
  git fetch origin <base> && git rev-list --count plan/<id>-<handle>..origin/<base>
else
  git rev-list --count plan/<id>-<handle>..<base>     # NO-REMOTE: the local base is the only one
fi                                                     # commits on the base the branch does not have
```

Count against `origin/<base>` wherever `origin` exists: the PR is opened against the remote, and a
PR merged through `gh` moves no local ref, so the local `<base>` can read zero over a branch that
lacks a merged dependency. A fetch error is reported and stops the handoff; it is never read as
zero.

Non-zero → **say so and stop before the gate**, naming the count. Bringing the branch up to date is
a write, and it is the human's call which way — merging the base in, or `/quenching-git-sync`'s own
rebase, which carries the recorded task subjects through the rewrite. Never do it unasked, and
never run the gate over a branch you know is behind.

**Under `autonomous` the answer is given, and it is the merge.** A sibling spec merged mid-wave is
the ordinary way to be behind, and a `needs-human` there is never relaunched. Run
`git merge --no-edit origin/<base>` — a merge, never a rebase, so the task shas stay ancestors and
the verifier's check 7 accepts them — and then the gate over the merged tree. A conflict only in
generated files (`plugins/claude/quenching-specs-reader/**`) is mechanical: take the base's side
(`git show :3:<path> > <path>`, `git add <path>`), then **regenerate before concluding the merge** —
`python3 scripts/sync_specs_reader_plugin.py --write` — `git add` what it rewrote, and conclude
the merge. A manifest taken from the base alone loses the branch's entries. Then
`python3 scripts/sync_specs_reader_plugin.py --check` exits 0. A conflict in any other path →
`git merge --abort` and `needs-human` naming the paths.

**An inconclusive result is not a green one.** A check that cannot tell "this failed" from "this
could not be measured" has returned no verdict — say which it was, and ask (§Under `autonomous`:
`needs-human`), rather than merging on it. Where the repo keeps `/docs/standards/quality/surface-verification.md`, its §The five
preconditions a check must satisfy is where that distinction is defined for the command surface.

**Run the scope the diff justifies.** A check with a `--only`-style selector gets the subset this
branch can actually break, because a harness that spawns fresh agent sessions bills for every one.
When the repo's `## Validation` names
the scope, follow it; when it does not, run what it says and report the cost as a finding worth a
selector.

The gate passed — the branch is reviewed, distilled, archived, and proven. For a `done` outcome,
read the complexity from the status payload already in hand. **`low` chains the provider handoff
now:**

```text
Skill("quenching-git-pr-create", "<id>")
```

Invoke it with the spec id; `/quenching-git-pr-create` owns its own confirmation, push and PR
record. Do not offer a second handoff or invoke `/quenching-git-merge` on the low path.
**When this run's input carried `autonomous`, do not invoke it:** the orchestrator hands push and PR
to the `git-steward` after the verifier accepts the spec. Name the handoff (`/quenching-git-pr-create
<id> autonomous`) in the report and stop. **For
`medium`, `high` and `xhigh`, name the handoff and stop:**

Use the provider configuration already read in step 1 to name the next command: recommend
`/quenching-git-pr-create` when the configured provider supports the PR route, otherwise
`/quenching-git-merge`. The human picks, and neither is invoked from here. Name the branch and the
base so the recommendation is copy-pasteable. Add one line: once the merge lands, `/quenching-git-cleanup` removes finished work branches and worktrees, listing the ones that must stay (open PR, checked-out worktree, unmerged commits) with the reason; nothing is deleted without the human's confirmation. For an `abandoned` outcome, skip this handoff and
follow the branch-disposal path below.

For `abandoned`, there is nothing to hand off toward — do not remove any worktree; frame and make
the branch-delete offer per
[specs-conclude/abandoned.md](.agents/quenching/assets/references/specs-conclude/abandoned.md)
§The branch-delete offer, informed rather than defensive, default **keep** (taken unasked under
`autonomous`), and record the choice and fate in the report.
**Done when:** the gate ran green on the branch and the handoff was named, or the run recorded why
nothing could be handed off — a red gate, or (abandoned) the branch's own fate decided instead.

### 7. Report

**When this run's input carried `autonomous`, skip the read below and the mold with it** — a conductor presents the report, not this run; return the content in the fixed shape the caller specified. Otherwise:

```bash
.agents/quenching/bin/cq components read .agents/quenching/assets/references/specs-develop/report-mold.md \
  --sections "§The report mold" --rules-only
```

Emit §The report mold. The single-spec header line carries the archived locator and the outcome; three
body blocks:

1. **At close** — fixed. Task progress, `reviewed` / `branch` as they now stand, and — for an
   abandonment — that nothing was adopted and what became of the branch.
2. **The review** — fixed. What it found and what was done about it (and the Codex line: `Codex: reviewed (<n> findings, <m> reproduced)` or `Codex: fallback (<reason>)`), the docs written in step 3 and
   step 5, and what the pre-merge gate returned. §Quoting a tool's own output governs the gate's
   result, which means **a check that came back inconclusive is named as such, never counted as
   passed**.
3. **Unresolved `## Discoveries`** — optional, each line named. They are
   `/quenching-specs-develop`'s discoveries stage to close, and they are easiest to lose at exactly
   this moment.

Print §The session-size line before the block — `.agents/quenching/bin/cq components session context --json`, read once; exit 1 turns the `→` line into a recommendation to run that handoff **in a new session**, exit 0 and 2 leave it an offer.

Close on §The next-step block, its recommended line naming step 6's handoff — `/quenching-git-pr-create`
or `/quenching-git-merge`, whichever was recommended, or `/quenching-specs-develop <id>` when
block 3 has rows and that needs settling first.
**Done when:** path, outcome, records, both `/docs/` passes and the next-step block are all
reported.

## Invariants to never violate

- Never infer the outcome. `done` and `abandoned` are the human's word, always — under `autonomous`,
  the explicit `--outcome` the caller passed, and nothing else (§Under `autonomous`).
- Never treat staleness as evidence of abandonment.
- Never pass `--force` unprompted — a refusal is information, not an obstacle.
- Never hand off an abandoned spec's branch toward a merge — offer to keep or delete it instead.
- **Never `git branch -D`, at all**, when framing the abandoned branch-delete offer — git's own
  refusal over a not-fully-merged branch is the safety, and forcing past it destroys the only copy
  of work nobody adopted.
- **Never hand off past a red `## Validation` gate**, and never count an inconclusive check as a
  green one.
- **Never run the gate over a branch that is behind its base.** Report the count and stop; bringing
  it up to date is a write, and which way is the human's call. Under `autonomous` the call is made:
  the base is merged in (step 6), never rebased.
- **This command's own commits end at step 5.** Nothing it does writes to the branch after the gate
  in step 6, except the base merge `autonomous` runs before that gate — the merge, the PR, and whatever they each commit belong entirely to
  `/quenching-git-merge` and `/quenching-git-pr-create`, run separately, on the human's own word.
- Never overwrite the `writeOnce` `outcome` record to make reality fit — report the disagreement
  instead, and never edit the frontmatter to get past `.agents/quenching/bin/cq specs record`'s refusal.
- Never re-run a stage whose signal is already set without saying so and being asked to.
- Never re-write a rule a task already wrote into `/docs/standards/` during execution — concluding
  syncs nothing.
- Never settle a release obligation for an **abandoned** spec, and never invent one no standard
  states.
- Never bulk-copy a spec into `/docs/`; only what outlives it crosses.
- Never distil an abandoned spec's decisions as adopted knowledge; `background` is the ceiling.
- Never edit or delete anything already in `archive/`, with exactly one exception, onto the spec
  this run is closing: the distillation's `## Outcome` append, which records a fact that did not
  exist at the archive move and revises nothing the spec claimed. Never touch a spec other than
  that one, nor an archived spec from an earlier run.
- Never rewrite history: no amend of a task commit, no force-push, no `--no-verify` and no
  `--no-gpg-sign` on the commits this command makes.
