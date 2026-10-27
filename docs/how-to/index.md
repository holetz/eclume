# `how-to/` — recipes for whoever installs, integrates and develops eclume

Step by step for a concrete task, valid for any installation: nothing here depends on the host of
this production, which has its own runbook in [project/](../project/index.md). Every page has
`type: how-to`.

* [auto-hospedar.md](auto-hospedar.md) — bring up eclume on your own server, with or without a GPU: requirements, `.env.prod`, deploy through a Docker context, first admin, summary provider, local network, internet and signup
* [integrar-com-a-api.md](integrar-com-a-api.md) — a program using the v1 API on behalf of an account: the server's CA, token and scopes, Bearer, cursor, synchronization by `since` with `id` + `revision`, `problem+json` errors, retry limit and MCP
* [desenvolver-sem-gpu.md](desenvolver-sem-gpu.md) — from clone to a transcribed and summarized recording on a Linux or Windows machine with no GPU and no build host
