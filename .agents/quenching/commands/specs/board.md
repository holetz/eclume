---
description: "Open the local spec portal: board, ranking and detail in the browser over the same backend. Use for \"open the spec board\", \"show the specs visually\". Not for: ranking by chat → /quenching-specs-triage; reading → /quenching-specs-status."
disable-model-invocation: true
argument-hint: "[--read-only] [--port N]"
allowed-tools: Bash(.agents/quenching/bin/cq:*), Bash(.agents/quenching/bin/cq.cmd:*)
---

# /quenching-specs-board — start the local spec portal

**Input**: `$ARGUMENTS` — optional `--read-only` and `--port N`, passed through unchanged.

A launcher. The server, its token and its security rules live in `.agents/quenching/bin/cq specs serve`; do not restate
them.

## Workflow

### 1. Start the server
Resolve `cq` per [align/tool-resolution.md](.agents/quenching/assets/references/align/tool-resolution.md)
§Resolving the tool; branch on the exit code. Run `.agents/quenching/bin/cq specs serve --json $ARGUMENTS` with
`run_in_background: true`, then read its first output line.
**Done when:** the first line is the JSON with `url`, or a refusal with its `code` is reported.

### 2. Print the URL
Print the `url` as given, with its token, and whether the portal is read-write or read-only and why.
Say that Ctrl-C or stopping the background task ends it, and that execution stays in the host
(`/quenching-specs-execute <id>`).
**Done when:** the URL and its mode are shown.
