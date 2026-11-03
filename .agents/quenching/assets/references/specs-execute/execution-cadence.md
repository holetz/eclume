# Specs execution — handoff cadence and boundaries

This file owns the resumability cadence, section boundary and progress banner of the execution
loop. The verify/commit mechanics and delegation rules live in focused siblings.

## The Handoff cadence

<!-- rules -->

The four events are the command body's. Why four events rather than a threshold or a judgment:
§Tooling asides.

**The four events say when a Handoff update happens; they do not add another boundary event.** Since
`## Handoff` gained per-section blocks — a small global block plus one `### N.` block per `## Tasks`
section — an update at any of the four events targets ONE of the two:
`.agents/quenching/bin/cq specs section <id> Handoff --write --scope global` for the evergreen block, or `--scope
current` for the block of whichever `### N.` still has open work. A section's block closes — stops
being targeted — the moment its last task commits, but that close adds no fifth event: `--scope
current` always resolves to whichever section still has an open task, so once `### N.` has none
left, the NEXT of the four events to fire already writes `### (N+1).` instead, wherever in the run
that next event happens to land. A section whose every task commits between two Handoff updates
never gets a block of its own at all — `--scope current` opens one on demand when the next event
finally fires, borrowing that section's own `## Tasks` heading as its title.

## The section boundary — where a run may stop

<!-- rules -->

A `## N.` section's last task committing, with another section still ahead, is a **clean boundary**:
the loop keeps the task commits and continues with the next task.

- **The trigger is that event, never a window size; the measured size decides only the tone.** The
  boundary reads `.agents/quenching/bin/cq components session context --json` once. Within the budget, or unmeasured
  (exit 2), the loop continues and the boundary is not a question. Over it (exit 1), the loop asks
  once, recommending a new session; continuing stays an option. A count never stops a task midway.
- **Nothing extra is written.** `## Handoff`, `git log`, and the `subjects` `.agents/quenching/bin/cq specs status`
  returns already carry everything a fresh session needs; the boundary adds no record and no fifth
  Handoff event.
- **Only a human-required question or a real blocker pauses the loop.** A section boundary is
  neither; the pause conditions remain the command body's own.
- **The contract still ends at the last commit.** Reaching this boundary is not a close-out: the
  branch review, the merge and the archive remain `/quenching-specs-conclude`'s, exactly as they are
  for a run that goes to the end.

## The loop's progress banner

<!-- rules -->

Progress as it happens, not a report — §The report mold governs the run's step 7, this governs the
loop itself. Its glyphs are the mold's and mean the same. **Only the mold's own header line opens
with a `##` that carries the slug** — this banner prints plain text, never a heading, so the two can
never be confused for each other:

```
Building: <slug>

Task 3/7 — 3.2 <task title>
  files: src/middleware/auth.ts, src/config/limits.ts
✓ self-review: clean
✓ chain: verify && check && commit
    verify: pnpm test middleware/ — passed
    checked 3.2 (subject: plan/<slug>: 3.2 <task title>)
    committed a1b2c3d — subject matches
```
