# Spec-driven document — lifecycle, identity and gates

**This file is the single owner of the spec document's format** — identity, frontmatter,
canonical sections, gates, derived stages, the executor contract and the boundary with the OKF
bundle. The `.agents/quenching/bin/cq specs` tool surface and the report shape live in focused references, and every
`/quenching-specs-*` command cites the smallest owner instead of loading this file whole. The OKF
bridge (what durable knowledge crosses from a spec into `knowledge/` and how) lives with the close-out command
([specs-conclude/distill.md](.agents/quenching/assets/references/specs-conclude/distill.md)).

**A spec is a document on the `quenching` branch** (the git store), with an optional thin tracker
card (GitHub issue or Azure Boards work item) as its human-facing projection. The document carries
the same thirteen sections, frontmatter records, and derived stages throughout its lifecycle. The
`github` and `azure-boards` backends, which keep the document in the tracker item, are deprecated
but work. Every command drives `.agents/quenching/bin/cq specs`, never a repository path or the tracker item.

What every backend owes that model — the five primitives, the obligation to reassemble the whole
canonical document on read, and refusal on unsupported selection — is owned by
`/docs/standards/architecture/spec-backend.md` and never restated here.

## Contents

`.agents/quenching/bin/cq components read <this file>` returns the heading index; `--sections` addresses one.

## The scale

<!-- rules -->

Four levels, and each changes something real in the **definition** half — how the spec is reached
and argued with. The building half deliberately has one continuous mode for every level, so a
level that changes nothing in definition is vocabulary and this table is the whole of what each one
buys:

| Level | Defining — who answers, and whether the spec is argued with |
| --- | --- |
| `low` | the pass **composes** the whole spec from evidence and interrupts nobody; it **never refines**; it stamps `approved` itself, `by: low-gear`, and the review window is the spec's URL in the backend |
| `medium` | the pass **asks at every stage of the composition**, and does not refine on its own — the closing screen recommends it where a signal fired, and taking that recommendation raises the level |
| `high` | `medium`, and **the refine pass runs automatically** once the composition closes: the spec is argued with rather than only completed |
| `xhigh` | `high`, plus the refine pass's **premortem lens runs unconditionally** — not only when the spec's own risk triggers it |

**Building is the same at every level:** every stage runs in one session and crosses section
boundaries without pausing. The loop stops only for a question that requires a human answer or for
an actual blocker.

**Where the levels split, twice, and neither split is about how much work there is.** The first is
**who answers**, and it falls between `low` and everything above it: `low` interrupts nobody, every
other level asks at every stage of the composition. The second is **whether the spec is argued with
without anyone asking for it**, and it falls between `medium` and `high`: `medium` composes and
recommends, `high` and `xhigh` refine on their own authority. `low` is therefore the only level
that is fast by construction, and that is its whole content — a spec that should be defined without
a conversation asks for it by name. Neither distinction changes the continuous execution loop.

At the end of a `low` build, the close-out command carries the PR handoff by `Skill` after its
green gate: `Skill("quenching-git-pr-create", "<id>")`. The PR command keeps its own confirmation,
push and provider record; `low` removes the extra handoff choice from `conclude`, not the safety
gate owned by the PR command. The other levels retain `conclude`'s named handoff for the human.

**Defining is never isolated in a sub-agent, at any level.** Isolation means only the summary
returns, which is incompatible with stopping to ask — and every level but `low` asks. `low` could
be isolated and is not: it is one pass landing one edit, so the returned summary would be as large
as the work, which is the sub-agent mode's own test failing (§The scale).

**A level selects the definition mode, not the execution mode.** The execution loop is continuous
across section boundaries for every level; its only stops are human-required questions and real
blockers. Delegation remains a separate decision for one stage, so the `priority` record and the
commands need no second vocabulary for execution.

**What the scale measures.** Not the size of the change, its scope or its difficulty — a small
change can still need a human at every step, and a large mechanical one can need almost none. It
measures **how much a human needs to be part of the process**, and the definition column above is
that measure spent. `triage`, `create` and `develop` propose a level against this criterion, never
against the word's plain reading.

**Absent reads as `high`, never `low`.** A spec whose `priority` record carries no `complexity` has
nothing to derive from, and the two errors are not symmetric: `low` is a positive claim — *this can
run unattended, and the pass may stamp the go itself* — and it is the one that costs when it is
wrong. Guessing upward costs a refine pass nobody asked for; guessing downward costs a spec built
on nobody's word (`/quenching-specs-triage` states the same asymmetry for a ranked
row's floor).

**Every defining stage reads the level from a payload it already fetches.** `.agents/quenching/bin/cq specs status --spec
<slug> --json` returns `records`, and `priority.complexity` is inside it — so reading the gear costs
no call of its own. The execution loop does not consult this field for section boundaries.

## The spec document

<!-- rules -->

**One spec is ONE canonical document for its entire lifecycle.** Phases enrich it; they never
split it. `.agents/quenching/bin/cq specs` reads the complete document on every read. The card is never the source: a
human's comment on it is discussion, and an edit to its body is overwritten at the next transition.
The open or archived phase is the document's directory, and the stage and outcome derive from the
document.

Isolation-while-building is what a **branch or worktree** provides, with real merge, history, and
reversion (what crosses into `knowledge/`: §Boundary).

The store owns the locator and lifecycle transition. `promote` archives the document on the
`quenching` branch and closes the card; it moves nothing on the code branches. What does not change is anything a command can
observe through `.agents/quenching/bin/cq specs`.

<!-- rationale -->

**Why one document.** A `backlog/` ↔ `ready/` split bought exactly one fact no derivation
reproduces: *that this spec may be built*. Everything else it implied — that the spec is complete
enough to build — is computable from the sections themselves, and now is (§Derived stages). That
authorization is `approved:` in frontmatter, with `by:` naming whose it is, so the fact survived and
the folder did not.

## Identity: the spec ID and the locator

<!-- rules -->

**Every spec has a stable `<id>` identity owned by its store.** With a card it is the card's native
number (issue number, work-item ID); without one it is the branch's counter. The capture date is
`date:` in the document, written **once, at creation**; transitions never change the ID or the date.

**Identity is the ID, not the locator.** Every command and cross-reference names the ID; `.agents/quenching/bin/cq specs`
resolves that exact ID through the configured store. The file path, card URL and any exported path
locate the document but are not identity, and a title is descriptive data rather
than a key. A missing ID is a refusal (exit 2), never a title or fuzzy-match fallback.

<!-- rationale -->

**Why the date is not part of the ID.** A leading date would make the ID a synthetic basename purely to carry a date, and the one native
value that could replace it — a card's or issue's `created_at` — is when the item was made, not when
the spec was captured. So the date remains declared in the document, where every backend reads it
through the one shared derivation, and `next --front` sorts on it rather than on a listing's order.

## Frontmatter

<!-- rules -->

Write-once, low-churn fields only. Machine state a human never reads does not belong in a spec.

**Frontmatter records human judgments. The filesystem, git and section presence record everything
else.**

| Key | Required | Written by | Meaning |
| --- | --- | --- | --- |
| `slug` | always | `create` | the identity key every command and cross-reference names |
| `title` | always | `create` | one human-readable line |
| `date` | always | `create` | `YYYY-MM-DD`, the capture date — stamped once and never rewritten (why it is not the basename's prefix: §Identity) |
| `verification` | **optional** | `create` / `develop` | `per-task` · `per-section` · `end-of-plan` — when `verify:` runs. Absent means the default (`per-section`), applied on read; written after capture with `.agents/quenching/bin/cq specs verification`, **never** by editing the frontmatter |
| `priority` | once ranked | `triage` | `{level, criticality, complexity, date}` — a human's ranking against every other spec. `complexity` alone is also written at capture, by `create` — the one field of this record a second command may write (`assets/specs/schema.json`'s `complexity.writtenBy: [triage, create, develop]`) |
| `refined` | once interrogated | `develop` | `{mode, date}` — that a real interrogation happened, and which operation ran it |
| `approved` | once approved | `develop`, or `execute` inline | `{date, by}` — **that this spec may be built, and on whose authority**: `by: human` is a person's word, `by: low-gear` the level's, `by: orchestrator-forced` a conductor's forced `low` over a higher level; absent reads as `human` |
| `branch` | once building | `execute` | `{base, work}` — after a merge, git cannot say what the base was |
| `pr` | once opened | `conclude` | `{number, url, date}` — a PR opened but not yet merged, distinct from `merge.pr`, which is stamped only once the merge already happened. Restamped if the PR is recreated |
| `reviewed` | once reviewed | `conclude` | `{date}` — that a human read the whole branch diff |
| `merge` | once merged | `conclude` | `{strategy, subject, pr}` — the strategy was a choice, the subject names the merge it produced. Known BEFORE the merge, so the stamp lands on the work branch and the merge is the last action. `rebase`/`fast-forward` create no merge commit, so the subject is an explicit none. `pr` names the pull request the PR route opened — absent on every local conclusion, and **refused** under `fast-forward` (`sp-merge-pr-no-route`), the one strategy `gh pr merge` cannot perform |
| `outcome` | at archive | `conclude` | `done` · `abandoned` — stamped by `promote --to archive` |

Read top to bottom, the optional records **narrate the spec's history**: ranked, interrogated,
approved, isolated (or explicitly not), PR opened, reviewed, merged, closed. Not "built" — `branch`
narrates whether isolation was taken, never that the work finished; "built" is the derived stage
`executing`, which a spec built in place — `branch.work` equal to `branch.base` — still reaches
exactly the same way an isolated one does. An absent record is a *not-yet*, never a defect.

`writeOnce: true` (`approved`, `branch`, `merge`, `outcome`) marks an irreversible transition, where
rewriting the value would falsify something that already happened. `writeOnce: false` (`priority`,
`refined`, `pr`, `reviewed`) marks a standing judgment its **owning command** may restamp — which is
why those four carry their own `date`. In neither case may a command other than the owner touch the
record. The declared shapes live in `assets/specs/schema.json` under `frontmatter.records`.

**There is no `created` field**: `date:` is that fact, and one truth never gets
two declared sources. Nor a `phase` field (the folder is that fact), nor a `ready` field (the ten
gate sections are that fact). `slug` is the deliberate exception — it is the identity key, so a
mirror inside the file is worth its keep, and `validate` compares it to the filename suffix. A
merely derived fact earns no such mirror.

There is no attempt counter and no `.specs.json`.

**Four more keys — `tags`, `assignee`, `start`, `target` — are STATE, never records.** Each is a
first-level frontmatter key with its own deterministic verb (`.agents/quenching/bin/cq specs tags|assignee|start|target
<id> [value]`), not a `{field: value}` record and not owned by one lifecycle command. `tags` is
also written at capture — `.agents/quenching/bin/cq specs new --tags` folds a resolved `subjects.<KEY>`'s own fixed tags
in automatically, so the whole list still lands in ONE write rather than the capture's own tags
followed by a second, separate `.agents/quenching/bin/cq specs tags` call. On the git store all four live in the document's frontmatter; the card shows
tags and assignee as labels and assignees at transitions. A deprecated tracker backend instead
stores them natively and reassembles them on read (`docs/standards/architecture/spec-backend.md`
§Legacy tracker backends).

**`title:` is the one short description a spec carries.** It names the change and is the source
for the `Summary` column in the ranked table. The title is supplied at capture, retained in
the canonical document and projected to the card's title; it is never inferred from an ID
or replaced with a generated `titleize` fallback. A descriptive title keeps the capture useful
without a second summary field or a correction verb dedicated to maintaining one.

## The thirteen sections

<!-- rules -->

The canonical set, in canonical order. **Headings are a parsed contract** — canonical English, like
frontmatter keys. A heading outside this set is a **stray** and `validate` flags it. Which language
the body prose is written in is owned by the bundle's `docs/standards/agents/communication.md`.

| # | Heading | Phase | Moment |
| --- | --- | --- | --- |
| 1 | `## Problem` | definition | decision |
| 2 | `## Proposal` | definition | build |
| 3 | `## Out of Scope` | definition | build |
| 4 | `## Impact` | definition | build + **parsed** |
| 5 | `## Validation` | definition | close (plus the agent's `verify:` fallback) |
| 6 | `## Design` | definition | build |
| 7 | `## Alternatives Considered` | definition | decision |
| 8 | `## Open Decisions` | definition | decision |
| 9 | `## Risks` | definition | decision |
| 10 | `## Handoff` | execution | build |
| 11 | `## Tasks` | execution | build |
| 12 | `## Discoveries` | execution | — (no moment) |
| 13 | `## Outcome` | archive | close |

**Every section declares its moment, and that is load-bearing.** `## Proposal` / `## Out of Scope`
/ `## Design` / `## Impact` / `## Handoff` / `## Tasks` are the `build` set — exactly what
`/quenching-specs-execute` step 4 sends an executor (`.agents/quenching/bin/cq specs section <id> --moment build`).
`## Problem` / `## Alternatives Considered` / `## Open Decisions` / `## Risks` are
`decision` — the human's, weighing whether to build at all. `## Validation` / `## Outcome` are
`close` — `/quenching-specs-conclude`'s. `## Discoveries` carries no moment: captured
indiscriminately while building, it is resolved later by `/quenching-specs-develop`'s triage sweep, on its own
schedule.

- **`## Validation`** is the fallback for a task with no `verify:` line.
- **`## Impact`** is machine-parsed (see below). Removing the heading silently disables a check.
<!-- rationale -->

The moments replace an earlier human/agent binary that named *who* read a section without
saying *when* — `## Design` was human-only under it, yet an executor needs the decisions that stop
a task from "fixing" something deliberate, which is exactly why it is `build` now.

## The gates and the stage-scoped explicit-none rule

<!-- rules -->

A section is required — and required to carry an explicit `- none — <reason>` when it has nothing
in it — **only once its own gate is reached**. Before its gate, a heading's absence is not an
omission; it is a *not-yet*.

| Gate | Required sections |
| --- | --- |
| `new` (creation) | `## Problem` |
| `ready` (**derived**) | the nine definition sections (`## Problem` … `## Risks`) **and `## Tasks`** |
| `ready` (warning only) | `## Handoff` non-empty |
| `promote → archive/` | `## Outcome` |

**`ready` is a derived stage, not a folder, and it refuses nothing.** Filling those ten sections is
what makes a spec ready; no file moves, so there is nothing to refuse. It is a **floor** that
`/quenching-specs-execute` reports against — and the tool simply has no task to hand out until the ten are
filled, which is where the old promote's teeth went. The OK to build is a separate fact,
`approved:`, asked for inline rather than encoded in a folder — or, under the `low` gear alone,
stamped by the pass itself with `by: low-gear`, the human having authorized the mode rather than
this spec — or `by: orchestrator-forced` when a conductor running `--autonomous` forced that gear.

`## Tasks` is in that set because nothing may be built with nothing to execute.

Three rules decide whether a section counts as filled:

1. **`- none — <reason>` counts as filled.** An omission and a null are different facts, and an
   explicit null is strictly more information than an absent heading. It costs one line.
2. **A present-but-empty heading is malformed and refuses.** It is neither an answer nor a
   not-yet.
3. **An absent heading before its gate is legal.** `.agents/quenching/bin/cq specs new` stamps `## Problem` and nothing
   else — a captured spec is four lines of body, not a thirteen-heading skeleton.

The sets live in `assets/specs/schema.json` and are read by **both** `promote` and `validate` — one
source, two consumers (the ten gate sections: §Derived stages).

<!-- rationale -->

**Why the rule is scoped rather than absolute.** Applied absolutely it would kill the derived
stage: since `- none — <reason>` counts as filled, a freshly created spec carrying thirteen
`- none` sections would derive as `designed` and clear the whole ready gate without anyone having
thought anything. Stage-scoping is the version where both rules survive.

Admitting a present-but-empty heading (rule 2) would reintroduce the ambiguity this rule exists to
remove.

## Derived stages

<!-- rules -->

Sub-stages are **computed from section completeness, never declared**. Declared state is forgotten
on edit and goes stale; derived state regresses automatically when a section empties. The
computation reads **heading presence**, never a three-state body.

Resolution is **last match wins**, so a spec always reports the most advanced stage it has earned.

| Stage | Derived from |
| --- | --- |
| `captured` | only `## Problem` filled |
| `proposed` | `## Proposal` filled |
| `designed` | `## Design` filled |
| `refined` | a `refined` record in frontmatter |
| `ready` | the ten gate sections filled (`gate: true` — the single source of that set) |
| `approved` | an `approved` record in frontmatter |
| `executing` | any `[x]` or `[!]` box |

`approved` sorts after `ready` because a human may say go before every section is filled — `execute`
asks inline and stamps rather than refusing. `executing` sorts last because it dominates all of
them.

**`## Handoff` filled is NOT one of these triggers, and used to be.** The premise was that only
someone already building writes a handoff, and it does not hold: `## Handoff` is where a spec
declares post-merge field validation, an obligation known at definition time. Filling it at the
right moment dropped the spec to `executing` before a single box existed — measured on a spec whose
`## Tasks` was still empty and which had not even reached the `ready` gate, reported as under
construction and ranked against specs with code in flight. A ticked box is the honest signal
because `.agents/quenching/bin/cq specs task` writes it only after a commit; nothing else on this list can be written by
accident.

`.agents/quenching/bin/cq specs list` and `.agents/quenching/bin/cq specs next --front` both group by these stages, deriving them from disk
on every call.

## `## Impact` — the one parsed declaration

<!-- rules -->

`## Impact` is declared scope for human review, with exactly one machine-checked part:

```markdown
### Standards this spec will write into docs/standards/

- `docs/standards/auth/session-tokens.md` — how a session token is minted and revoked
```

`parse_impact_standards()` reads the `docs/standards/**.md` paths bulleted under **that heading and
only that heading**, and `validate` emits `sp-impact-uncovered` (warn) for any path no `## Tasks`
item names.

Two exclusions are deliberate: the **sibling sub-headings are not parsed** (a background standard
the spec *may* resolve, and the product code it touches, name paths the spec never promised to
write), and an unfilled `<placeholder>` declares nothing. A spec with no such sub-heading declares
nothing and is never flagged — **the check is opt-in by writing the heading**.

A bullet may carry a `§`address beside its path —
`docs/standards/automation/skills.md §The verifier` — naming exactly which sections of that
standard the task must honor. `parse_impact_standards()` already tolerates it: the regex matches
only the `docs/standards/**.md` path and ignores the rest of the line, addressed or not. Without an
address, `/quenching-specs-execute` step 4 reads the file whole — the address is an
assertion the spec's own author makes, never an economy the executor infers on its own.

## `## Tasks` and the `[!]` blocked marker

<!-- rules -->

Checkboxes `- [ ] <id> <text>` grouped under `### N. <Section>` headings, carrying optional
`files:` / `verify:` / `pattern:` / `subject:` / `commit:` / `[P]` metadata. `.agents/quenching/bin/cq specs task
--check <id>` flips a box mechanically — **never by string surgery**.

`subject:` and `commit:` are written by `task --check --subject <line> --commit <sha>` and record
the subject and sha of the commit that implements that task. They live on the task line rather
than as a trailer inside the commit message, which leaves the target repo's message format
entirely its own. The task is checked after the local commit because the spec lives outside the code
branch and its write cannot be part of that commit; the recorded commit facts let a failed remote
write be retried without rebuilding or amending it
([execution.md](.agents/quenching/assets/references/specs-execute/execution.md) §The commit).
A spec built before this change may carry only `subject:` or only `commit:`; both forms are read and
neither is backfilled.
`## Tasks` is the file's churn zone by design — its boxes already flip — so the low-churn doctrine
that governs frontmatter does not reach it.

A blocked task is a **visible marker, not a hidden counter**:

```markdown
- [!] 2.3 Implement the gate check — blocked: schema.json has no `ready` set yet
```

Written by the orchestrator when it decides to stop retrying; `next` skips it. **There is no
attempt limit.**

`[P]` marks a parallel-eligible group, honoured only when the group's `files:` sets are provably
disjoint (`.agents/quenching/bin/cq specs parallel`). Serial by default.

<!-- rationale -->

The attempt counter's only value was stopping unattended retry loops, and an honest written reason
serves that better than a counter nobody sees — and it is readable by the human who has to unblock
it.

## The executor contract

<!-- rules -->

**The orchestrator is the spec's only writer.** An executor receives:

- its task line (with `files:` / `verify:` / `pattern:`),
- `## Handoff`'s global block plus the `### N.` block of its own section — never a
  section that already closed, and never the whole `## Handoff`,
- the touched subjects' `docs/standards/` contracts.

It does **not** receive the `decision`-moment sections (`## Problem` /
`## Alternatives Considered` / `## Open Decisions` / `## Risks`), nor the rest of the `build` set
verbatim. The orchestrator itself reads the `build` set at step 4
(`.agents/quenching/bin/cq specs section <id> --moment build --scope current`) — the other five sections whole, and
`## Handoff` already cut to the same global-plus-own-section slice the bullet above promises an
executor, so **neither side depends on an agent remembering to narrow it**; a `## Design` decision
that bears on the task reaches the executor distilled into the task line or `## Handoff`, never as
the section itself. It returns
a structured result — status, diff summary, `verify:` output, discoveries, handoff deltas — and
**never writes the spec**. The orchestrator applies everything via `.agents/quenching/bin/cq specs` (`task --check`, `discover`,
`section --write`), runs `verify:` itself, and commits: **whoever commits, verifies.**

Discoveries are **captured indiscriminately**; whether one is worth acting on is a later judgment,
not the executor's. They are born in the origin spec's `## Discoveries` and resolved in place by
`/quenching-specs-develop`'s discoveries stage — `promoted: <new-slug>`, `folded: <section>`, or
`dismissed: <reason>` — so provenance is never lost and the human pays the decision cost in batch.

`## Handoff` refresh is **bound to events, not judgment**: the orchestrator rewrites it on four of
them — the run pauses, a task is written blocked, a discovery is recorded, the run's last commit
lands — and on nothing else. Each names an act the executor just performed, never an assessment it
has to make, which is what lets the rule hold in an unattended run; staleness is this section's
failure mode, and `validate` warns when a spec past the ready gate has an empty `## Handoff`. What a
rewrite touches is scoped the same way what an executor reads is: `.agents/quenching/bin/cq specs section <id> Handoff
--write --scope global` for the evergreen block, `--scope current` for the block of the section
whose tasks are still open. A section's block is never targeted again once its last task commits —
that IS the close, no separate flag marks it — so a run that has moved on to `### 4.` never pays to
resend `### 1.` through `### 3.` again.

<!-- rationale -->

One writer with mechanical writes is also what makes one file safe under parallelism.

## Boundary: `specs/` vs the OKF `knowledge/` bundle

<!-- rules -->

**This section is the single normative owner of the boundary.** Every other statement of it cites
this section.

- `specs/plans/` — **the in-flight unit of work**: a spec's problem, design, and task checklist
  while it is being defined and built. Owned by the `/quenching-specs-*` commands; leaves for `archive/` when
  it is concluded.
- `docs/standards/` — **how WE build** (binding contracts: naming, architecture, code);
  `docs/concepts/` — generic understanding. A spec writes its durable rule **directly** into
  `docs/standards/` (`authority`-graded) **when a task explicitly names it**, and `/quenching-specs-conclude`
  routes what the work merely *revealed*
  ([distill.md](.agents/quenching/assets/references/specs-conclude/distill.md)) — never by bulk
  copy.

The spec **is** the change: what it proves out lands in `knowledge/` as it is built, honestly graded
(`authority: background` for an agreed-but-unproven rule, `current` for one the spec implemented
and proved). There is no second store for it to duplicate.

## The native-only claim, and why it was traded

**Nothing cites this section.** It is kept off every address a command loads, so it costs the reader
nothing and stays on disk in full.

<!-- rationale -->

This front once declared itself *entirely native — no external CLI, no Node runtime, no main spec
store, no delta format*. Three of those four still hold, and the wording above is what survives them:
stdlib-only Python is unconditional; there is still exactly ONE store, now whichever backend was
declared; and a backend that serialises natively is a mapping inside one implementation, not a delta
bridging two copies that can disagree.

The clause that was traded is **no external CLI**, and it was traded on purpose: putting an external
backend's transport on the vendor's own `gh` / `az` moves auth, paging and API errors out of this
plugin entirely. Worth knowing because the claim reads like a principle and was in fact a
measurement — the alternative was this plugin owning an HTTP client per tracker.
