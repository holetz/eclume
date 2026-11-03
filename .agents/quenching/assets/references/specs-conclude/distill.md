# Distill — the OKF bridge from a concluded spec to `knowledge/`

How `/quenching-specs-conclude` offers to carry the **durable** knowledge a spec produced into the
repo's OKF `knowledge/` bundle: this file decides **what crosses**; the insert mechanics live with
`/quenching-knowledge-add` ([knowledge-add/homes.md](.agents/quenching/assets/references/knowledge-add/homes.md)).

## What crosses, what stays

| The spec produced… | Cross? | OKF home / route |
| --- | --- | --- |
| a rule a task **explicitly named** under `## Impact` | **no** | `/quenching-specs-execute` **already wrote it into `docs/standards/`** as part of that task — nothing to do here. There is no separate spec store to sync |
| a **decision** (rationale + considered alternatives, usually in `## Design`) not yet captured as a standard | yes | `standards/<subject>/<concept>.md` (`type: standard`; `authority: current` if the spec proved it, else `background`) — there is no separate ADR home |
| **generic understanding** gained (domain insight, mental model, a learning from implementation) | yes | `concepts/<subject>/<slug>.md` (`type: concept`) |
| a **repo-specific term** the spec coined or clarified | yes | an entry in `glossary.md` (§Enriching the glossary in homes.md) |
| a **follow-up** the spec surfaced but did not pursue | yes | a fresh spec in `specs/plans/` via `/quenching-specs-create` — outside the `knowledge/` bundle, and never stamped with an OKF `type:` |
| `## Proposal` / `## Design` / `## Tasks` as documents | no | they are the archive's history; copying them into `knowledge/` duplicates a source of truth |
| task checklists, progress notes, transient debugging chatter | no | transient by nature |

The `specs/` ↔ `knowledge/` boundary is owned by
[`specs-develop/spec-driven.md`](.agents/quenching/assets/references/specs-develop/spec-driven.md)
§Boundary — when it and this table seem to disagree, the boundary wins and this table is wrong.

Boundary tie-breakers **within** `knowledge/` (standards vs concepts vs external) are the ones in
[homes.md](.agents/quenching/assets/references/knowledge-add/homes.md) §Classification — apply them verbatim.

## Two moments, one table

<!-- rules -->
`/quenching-specs-conclude` applies the table above **twice**, at two moments that differ only in
when the doc has to exist:

| Moment | What it catches | Where it lands |
| --- | --- | --- |
| **emergent** — right after the branch review | a rule the work *revealed*: a `## Discoveries` line worth a doc, something the branch review surfaced | `done` — the **work branch**, in its own commit, so the rule ships with the code that proved it. `abandoned` — the checkout holding `<base>`, since there is no merge left to carry it there |
| **distillation** — right after the archive move | the by-products that outlive the spec: a decision still in `## Design`, an understanding, a term, a follow-up | `done` — the **work branch** too, still before the merge. `abandoned` — the same checkout holding `<base>` as the row above |

**Both moments land in the same place: the work branch for `done`, so one merge carries everything;
the checkout holding `<base>` for `abandoned`, because there is no merge to carry anything at all.**

<!-- rationale -->
The top row is the load-bearing difference from the old delta model: because a task writes the
binding rule **straight into `docs/standards/`** while it is built, concluding is not a *sync* — it
is catching the **by-products** (a decision left in `## Design`, an understanding, a term, a
follow-up) that were never committed to a home. Most of what a spec proves is already in `knowledge/` by
the time it closes; the harvest is usually small.

A rule the code demonstrates belongs beside that code in history; a by-product of the *thinking* has
no code to ship with, and is cheapest to harvest once the spec is **closed** — which happens at the
archive move, in step 4, **on the branch**.

This file used to put the second one "on the base branch, after the merge", reasoning that a
by-product is cheapest to harvest once the spec is closed. The reasoning was right and the placement
did not follow from it: **closing and merging were being conflated.** A spec is closed when
`## Outcome` is written and the file moves to `archive/` — both of which happen on the branch,
before anything is merged. Harvesting there satisfies the same argument and leaves nothing to write
on the base afterwards, so reverting the merge reverts the spec's whole footprint, distilled docs
included.

## The procedure (one confirmation)

<!-- rules -->
Runs **after** the archive move succeeds, as the command's distillation step:

1. **Harvest candidates.** Read the archived spec's sections (`## Problem`, `## Proposal`,
   `## Design`, `## Discoveries`, `## Outcome`) and the conversation's own context, and check what
   `knowledge/` already received — during execution, and at the emergent moment above. List each
   **remaining** candidate as *one line*: what it is → proposed home + `type` + path (per the table
   above). Expect **zero to a few** — a spec that captured its rules as it went, and taught nothing
   else durable, is normal; say so and skip to done.
2. **One plan, one OK.** Present the candidate list as a single distillation plan and ask one
   confirmation. The user may strike items. If the OKF bundle is missing (no `knowledge/index.md` with
   `okf_version`), offer `/quenching-knowledge-align` first — only when `quenching-align` is
   enabled ([tool-resolution.md](.agents/quenching/assets/references/align/tool-resolution.md)
   §Routing into another module) — or skip distillation entirely — never scaffold ad hoc.
3. **Mint each approved doc** under the insert procedure
   ([homes.md](.agents/quenching/assets/references/knowledge-add/homes.md)): fill the home's mold, stamp the
   frontmatter (`resource` may cite the archived spec path — it exists, so the link is derived, not
   invented; `source:` names the spec), update the home's `index.md`, enrich the glossary when a
   term warrants it. A follow-up instead goes through `/quenching-specs-create` into `specs/plans/`.
4. **Narrate the bridge in the archived spec's `## Outcome`.** One line per minted doc —
   `distilled: [<title>](/docs/<path>.md) — <what it carries>` — appended to the `## Outcome`
   already written at the archive gate. An empty harvest writes nothing.
5. **Self-check** every touched file against
   [knowledge-align/conformance.md](.agents/quenching/assets/references/knowledge-align/conformance.md).

<!-- rationale -->
**Why there, and why this is a second edit to an archived file.** The bundle's `log.md` is
retired, and the provenance it used to carry has one honest home left: the record of the
spec that produced the doc. `## Outcome` is mandatory at promote and sits in the file a
reader of the archived spec already has open, so the bridge costs no new artifact. It has to
be written *after* the archive move because that is when the minted paths first exist —
`## Outcome` is drafted at the gate, before distillation knows what it minted. That makes
this the **second** bounded exception to "never edit anything in `archive/`", alongside the
`merge:` stamp, and for the same reason: both are facts that only come into being once the
spec has closed. Neither revises what the archived spec claimed; both append what happened
to it. Any third exception should be argued for, not assumed from these two.

## Invariants

- **Never bulk-copy** an artifact into `knowledge/` — distill the durable unit, cite the archive.
- **Never delete or revise** the archived spec while distilling — the archive is history. The one
  write permitted here is step 4's append to `## Outcome`, which records what the distillation
  produced and changes nothing the spec claimed.
- **Never mint without the one confirmation**, and never fabricate a candidate to have something
  to distill: an empty harvest is a valid outcome.
- A distilled `standard` claims `authority: current` **only** when the spec actually implemented
  and proved it; otherwise stamp `authority: background`.
