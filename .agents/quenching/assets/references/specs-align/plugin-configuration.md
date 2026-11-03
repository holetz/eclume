# `.agents/quenching.json` — the envelope and recognised namespaces

The specs front's own copy of what `.agents/quenching.json` recognises, with `.agents/quenching.json`
read as legacy while it exists — the root metadata and
namespaced declarations `.agents/quenching/bin/cq specs config` reads, their defaults, and the refusals a malformed value
earns. Specs live on the `quenching` branch: the file selects that store and configures the tracker card
and, for deprecated tracker backends, their transport and placement, never a repository specs
tree. Other namespaces are read by their owning front.

## Contents

`.agents/quenching/bin/cq components read <this file>` returns the heading index; `--sections` addresses one.

## The envelope and recognised namespaces

<!-- rules -->

| Key | Values | Default | Read by |
| --- | --- | --- | --- |
| `backend` | `git` · `github` · `azure-boards` (the last two deprecated) | derived from the repository remote | store selection and legacy-value refusal |
| `specs.card` | `{provider: github \| azure-boards \| none, at: capture}` | `github` on a GitHub remote, else `none` | the card layer, on the branch or here |
| `shared.worktreeSetup` | a shell command, run as written | none | the isolation cut, after `git worktree add` |
| `shared.sharedPaths` | a list of repo-relative paths | none — an absent or empty list declares no shared area | `.agents/quenching/bin/cq git worktree link`, from the isolation flow |
| `shared.regenerablePaths` | a list of repo-relative paths; a slash-less entry matches that name at any depth; a trailing slash (`data/`) anchors it at the root | none — an absent list declares nothing regenerable | `.agents/quenching/bin/cq git worktree retire`, which discards matching ignored files without `--discard-ignored` |
| `shared.hooks` | `{"<event>": [{"command": "<cmd>", ...}]}` | none — an absent key declares no events | the command that owns the event |
| `shared.profiles` | `{"installed": ["knowledge", "specs", "design", "components", "ops", "proof", "toolchain", "delivery", "opensource", "security", "git"]}` | none — an absent key leaves all eight local fronts eligible | the align conductor's conduction scope |
| `shared.gitConventions` | `{commitSubject, branchName, prTitle, prBody, mergeSubject}` — prose directives, never templates | `{}` | the whole `git` pillar, through `.agents/quenching/bin/cq git conventions`; see [git/conventions.md](.agents/quenching/assets/references/git/conventions.md) §The declared-directive layer |
| `shared.autonomy` | `{runAloneUpTo: none \| low \| medium \| high \| xhigh, merge: policy \| never \| dependencies \| all, maxWorkers: 1-8, maxLaunches: ≥ 1, livenessMinutes: ≥ 1}` — a bad leaf falls back to its default and is named in `warnings` | `{runAloneUpTo: low, merge: policy, maxWorkers: 3, maxLaunches: 40, livenessMinutes: 20}`, leaf by leaf | `/quenching-specs-orchestrate`, the `orchestrator` and `/quenching-specs-autopilot`, through `.agents/quenching/bin/cq config show --effective` |
| `shared.workHost` | `{target, dockerContext, runner, remoteRoot, syncFlags, syncExclude, pullBack, protectedPaths, minFreeGb}` — a bad leaf falls back to its default and is named in `warnings` | disabled until `target` is set | `.agents/quenching/bin/cq config host --plan`, which prints the dispatch steps and runs nothing |
| `shared.okfValidate` | `{warnAsError: boolean, ignoreGlobs: list of strings}` | `{warnAsError: false, ignoreGlobs: []}`, key by key; wins over `.claude/hooks/hooks-config*.json` | `.agents/quenching/bin/cq knowledge validate` |
| `shared.contextBudgets` | `{main, worker, conductor}`, positive integers | `{main: 200000, worker: 100000, conductor: 150000}` | `.agents/quenching/bin/cq session context`; `worker` is also the default of `.agents/quenching/bin/cq specs estimate --worker-budget` |
| `shared.codex` | `{crossReview: auto \| off, maxUsedPercent: {primary, secondary}, timeoutSeconds, model, executor}` — a bad leaf falls back to its default and is named in `warnings` | `{auto, {80, 90}, 900, gpt-6-astra}`, leaf by leaf | `cq codex` |
| `delivery.provider` | a provider name, declared explicitly | none — absent declares no provider; it chooses no pipeline policy | the delivery front (`delivery/config.py`) |
| `specs.artifactLanguage` | a non-empty string | none | `.agents/quenching/bin/cq specs`, on the branch or here |
| `specs.cardAt` | the sibling spelling of `specs.card.at` | none | the card layer, on the branch or here |
| `specs.chat` | `{model, budgetUsd, timeoutSeconds}` | `{sonnet, 0.50, 300}` | the portal's `--chat`; `--chat-budget-usd` wins |
| `specs.azureStates` | `{"plans": "<state>", "archive": "<state>"}` | **none, deliberately** — refuses (exit 2, `sp-az-no-states`) rather than guess | the `azure-boards` backend only |
| `specs.azurePlacement` | `{areaPath, workItemType, discoveryTag, team, iterationPath, boardColumn, defaultSubject}` — `workItemType` retired, see `workItemTypes` below | per sub-key — `areaPath` **none, deliberately**, the rest default | the `azure-boards` backend only |
| `specs.azureColumns` | `{"<board state>": "<lane>", …}` — any subset | `{}` — falls back to `azurePlacement.boardColumn` per state | the `azure-boards` backend only |
| `specs.subjects` | `{"<key>": {name, description, parent, tags}, …}` | `{}` | `/quenching-specs-create`'s subject proposal |
| `specs.tagCatalog` | `{"<tag>": "<description>", …}` | `{}` | `/quenching-specs-create`'s tag proposal |
| `specs.workItemTypes` | `{"<key>": {description, azure, github, default}, …}` | `{}` | `/quenching-specs-create`'s type proposal, `.agents/quenching/bin/cq specs new --type`, and every backend's `create_spec` |
| `ops.opsRoot`, `ops.router` | repository-relative paths | none — `op-config-missing` when absent | `.agents/quenching/bin/cq ops` |
| `ops.registry` | a repository-relative path | `<ops.opsRoot>/README.md` | `.agents/quenching/bin/cq ops registry` |
| `proof.proofRoot` | a repository-relative path | `tests` | `.agents/quenching/bin/cq proof` |
| `proof.layers`, `proof.measuredRoots`, `proof.proofExclusions`, `proof.ratchetPath` | proof declarations | documented proof defaults | `.agents/quenching/bin/cq proof` |

`specs.azureStates` is the one key whose absence is a refusal rather than a
default — a guessed state mapping would not fail loudly, it would read every archived spec as
active in half the projects it ran against.

`shared.gitConventions` is read by the `git` pillar rather than by `.agents/quenching/bin/cq specs`, and it sits here
because this table is the one home for what the file recognises. `shared` is its namespace for the
same reason `worktreeSetup` and `hooks` have it: the pillar runs inside every front's build loop.
Its two malformed shapes earn their own findings — `sp-config-unknown-git-convention` for a sub-key
outside the five, `sp-config-bad-git-convention` for a recognised one whose value cannot direct
anything.

Root-level front-owned keys such as `opsRoot`, `router`, `proofRoot`, `layers`, `hooks` and
`worktreeSetup` are legacy flat declarations. A flat or mixed document is refused with
`sp-config-unscoped` and exit 2, naming each key and its destination namespace; no namespace wins
and no value is merged.

The checker's `warnAsError` and `ignoreGlobs` are `shared.okfValidate`; `.claude/hooks/hooks-config.json`
stays the layer below, and the bundle root is the fixed `/docs/` convention no configuration names.

`.agents/quenching/bin/cq config init --write` seeds the file with every default above spelled out (the `shared.codex`,
`autonomy`, `contextBudgets`, `okfValidate` and `workHost` blocks and `specs.chat`); `.agents/quenching/bin/cq config check`
and `cq doctor` list the seeded keys a file lacks. They only report: an existing file is never
rewritten.

`cq doctor --setup` previews a minimal file from the detected provider and `--write` confirms it; it records the deprecated root `backend`, so prefer `.agents/quenching/bin/cq config init`.
