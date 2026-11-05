# Proof front gate contract

<!-- rules -->

This file is self-contained: a proof align reads it to decide measured scope, coverage floors,
failure collection, order evidence, CI parity and conditional operations-entry-point proof.

## Contents

`.agents/quenching/bin/cq components read <this file>` returns the heading index; `--sections` addresses one.

## The five gate rules

### 1. Measured surface and floor

The gate declares every source root it measures and associates each coverage floor with that root.
Coverage for one source root cannot be presented as coverage for another root or for an unmeasured
product surface.

`pf-unmeasured-surface` is raised when the suite claims coverage without naming the source root, or
when a tracked product surface is outside the declared measurement without an explicit reason.
`pf-no-floor` is raised when a measured root has no floor or ratchet record.

The floor is a coverage ratchet: a successful gate may raise it to the measured value, but no run
may lower it. The contract does not impose a universal percentage.

### 2. All declared layers run

The gate collects every layer declared by the target and reports a declared layer that has no
collected tests. Conditional layers are omitted with a not-applicable record; they are not created
as empty directories to satisfy the shape.

`pf-empty-layer` belongs to the layer contract, which owns the declaration-sensitive deciding
question. This gate consumes that result and does not define the code a second time.

### 3. Continue past the first failure

The default proof run collects all declared failures needed to repair the suite in one pass. A
first-failure mode may exist as a developer convenience, but it is not the repository gate unless
the target records why it is equivalent to full evidence.

`pf-stop-first` is raised when the authoritative gate uses `--maxfail=1`, an equivalent stop-first
setting, or a wrapper that discards failures after the first one.

### 4. Prove order independence

The suite runs with randomized or otherwise declared test ordering and records the result. A
single serial pass is not evidence that tests are independent; the order check must be repeatable
and its seed or equivalent must be observable in CI output.

`pf-order-unproven` is raised when no order experiment is declared, when the runner's order is
fixed without an independence check, or when the check cannot report its seed/equivalent.

### 5. Carry the gate into CI and the active interface

CI invokes the same proof command and preserves the measured roots, layers, floor and order
settings. When the repository declares an operations front, every active entry point that is part
of the presented interface has a test or a recorded not-applicable reason.

`pf-no-ci` is raised when the proof gate has no CI invocation or when CI invokes a materially
different contract. `pf-untested-entrypoint` is conditional: it is raised only when an operations
front is declared and an active entry point has neither a test nor an explicit not-applicable
record. Without an operations front, the code is not applicable.

## Finding codes

The gate contract owns these codes and no other reference defines them:

| Code | Meaning | Severity | Band |
| --- | --- | --- | --- |
| `pf-unmeasured-surface` | A claimed product surface is outside the declared measurement without a reason. | `error` | judgement |
| `pf-no-floor` | A measured source root has no coverage floor or ratchet record. | `error` | structural |
| `pf-stop-first` | The authoritative gate stops after the first failure. | `error` | structural |
| `pf-order-unproven` | Test order independence has not been exercised with observable evidence. | `error` | structural* |
| `pf-no-ci` | CI does not invoke the same proof contract. | `error` | judgement |
| `pf-untested-entrypoint` | An active operations entry point lacks test or not-applicable evidence. | `error` | judgement |
| `pf-coverage-missing` | `.agents/quenching/bin/cq proof ratchet` found no coverage artifact; the target's gate has not produced one. | refusal (exit 2) | refusal |
| `pf-coverage-invalid` | The coverage artifact exists but cannot be read. | refusal (exit 2) | refusal |
| `pf-coverage-no-measured-root` | The coverage artifact measures none of the declared measured roots. | refusal (exit 2) | refusal |
| `pf-floor-invalid` | The floor file exists but is malformed. | refusal (exit 2) | refusal |
| `pf-floor-regressed` | A measured root's coverage fell below its recorded floor. | `error` | judgement |
| `pf-floor-unmeasured` | A root has a recorded floor but the coverage artifact did not measure it. | `error` | judgement |

`pf-floor-regressed` and `pf-floor-unmeasured` go to the human: lowering a floor or dropping a root
is the owner's decision, never a repair. The four refusals stop the ratchet before it compares anything;
the closing command is the target's own gate producing a valid artifact or the owner fixing the floor
file. Either blocking finding or any refusal leaves the floor file unwritten, so `--raise` never
raised anything.

`pf-untested-entrypoint` is not a universal demand for tests around every script in every
repository. Its applicability is established by the operations-front declaration, and the
not-applicable record must remain visible to the proof README and gate report.

The `pf-order-unproven` band is conditional: `bands.md` makes it structural only when an existing
gate can take a bounded, non-blocking order experiment; otherwise it is judgement and the align
reports the target-owned CI change that would close it. The same file resolves the no-layers-
declared rule.

<!-- rationale -->

The gate rules keep a coverage number attached to the code and execution context that produced it.
The floor prevents silent regression without turning a percentage into a target detached from
source shape. Continuing after the first failure and testing order make the suite's evidence useful
for repair rather than merely useful for a green badge.

CI and active-entry-point checks close the local-machine boundary. They are conditional where the
target has no such interface because proof should describe an actual surface, not manufacture one
to satisfy a universal checklist.
