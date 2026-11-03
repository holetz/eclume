# Resolving a plugin tool

Front-neutral: every command body shells out to the same single entry point, `cq`, naming its
front as the first argument. The fronts are `specs`, `git`, `knowledge`, `components`, `design`,
`ops`, `proof`, `toolchain`, `delivery`, `security` and `codex`; all resolve it the same way.

## Resolving the tool

**Plugin mode: bare `cq …`.** the host appends `<pluginRoot>/bin` to `PATH` for every enabled
plugin, and the plugin ships an executable `bin/cq` there (a shim that re-executes
`assets/bin/cq`). Every command body and reference writes `.agents/quenching/bin/cq specs …`, never a path and never
`python3 …/cq`.

A body that runs `cq` declares `Bash(cq:*)` in its `allowed-tools`; without it the call prompts
(or is denied in a never-prompt session). A body must not widen it to `Bash(python3:*)`
to reach the tool.

The command is followed by the front and its subcommand: `.agents/quenching/bin/cq specs ...`, `.agents/quenching/bin/cq git ...`,
`.agents/quenching/bin/cq knowledge ...`, `.agents/quenching/bin/cq components ...`, `.agents/quenching/bin/cq design ...`, `.agents/quenching/bin/cq ops ...`, `.agents/quenching/bin/cq proof ...`,
`.agents/quenching/bin/cq toolchain ...`, `.agents/quenching/bin/cq delivery ...`, `.agents/quenching/bin/cq security ...`, `cq codex ...`. **There is no second form and no third
rung**: never look for a copy under a target's `.claude/hooks/`, never install one there, never
merge anything into a target's `.claude/settings.json` to make a tool resolve.

Branch on the **exit code** (0 ok · 1 findings · 2 refusal) and the `--json` payload, never on
prose.

### Deploy mode: the target-local payload

A repository installed with `cq deploy` carries the tool at `.agents/quenching/bin/cq` and has no
plugin `bin/cq` on `PATH`. Its command bodies call that literal target-local path; the generated
grant is `Bash(.agents/quenching/bin/cq:*)`. This is a **generated** copy owned by
`.agents/.quenching-deploy.json`, never a hand-installed third rung: upgrade it with
`cq deploy --write` from a new release, and never copy a `cq` into `.claude/hooks/` or edit the
user's `PATH`. The reference `.agents/quenching/bin/cq components read` remains the same; the local payload carries the
references under `.agents/quenching/assets/references/`.

### Modules: one `cq`, the fronts of the enabled modules

The plugin ships as modules (`quenching-specs`, `quenching-align`, `quenching-design`, …), and only
`quenching-specs` puts `bin/cq` on `PATH`; that one `cq` reaches the packages of every other
**enabled** module. A front whose module is not enabled answers **exit 2** naming the module to
enable, never a traceback. `cq modules --json` lists every module with `enabled: true|false`.

### Routing into another module

A route into a command of another module — a `Skill` call, an offer, a `Not for:` hand-off — runs
only when that module is enabled. Read `cq modules --json` once, where the route is about to be
taken: an enabled owner gets the route as written; an absent one is reported as
`not-installed: <module>` and the step continues without it (an offer is dropped, a stage is
skipped and named in the report). Never invoke a `Skill` whose module is absent, and never
manufacture the command it would have run.

### Working on the quenching repository itself

The `PATH` entry names the *installed* checkout, so a the target-local `.agents/quenching/bin/cq` there runs the plugin the session
loaded rather than the code being written. When editing this repository, run the checkout's own
file explicitly — `python3 plugins/quenching/assets/bin/cq …` — as the author's check. That is a
developer invocation, never something a command body or reference writes for a target.

### `.agents/quenching` is empty in a shell

The variable is substituted into a **command body's text** when the host loads it. **The shell
has no such variable**: the same spelling reached any other way (most often by opening a reference
with `Read`) expands to nothing. Bare `cq` needs no root at all, which is why it is the one form.
Anything else executable the plugin ships locates itself from its own `__file__`, never from
`.agents/quenching`.

### Write the resolved path literally on every invocation

Never hold an interpreter plus a path in a shell variable and expand it as a command — zsh does not
word-split scalars. Write `cq` on each call. **Chain several writes so a failure stops the run** —
`set -e`, or `&&` between them:

```bash
set -e
.agents/quenching/bin/cq specs section my-spec "Proposal" --write <<'EOF'
…
EOF
.agents/quenching/bin/cq specs validate --spec my-spec --json
```
