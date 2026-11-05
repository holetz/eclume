---
type: how-to
title: Integrate a program with the eclume API
description: How a program uses eclume's v1 API on behalf of an account — trusting the server's CA, creating an access token, choosing scopes and scope groups, authenticating with Bearer, paging by cursor, syncing by since while deduplicating by id + revision, reading problem+json errors and the retry limit, and connecting an AI assistant through MCP —, with the browsable reference at /referencia-api.html.
resource: contracts/openapi-v1.yaml, contracts/openapi-v1.bundled.yaml, web/src/features/tokens/scopes.ts, server/src/eclume_server/auth.py
tags: [api, integracao, pat, escopos, paginacao, mcp]
timestamp: 2026-10-01
audience: both
source: holetz/eclume#127
maintainer: holetz
---

# Integrate a program with the eclume API

This guide takes a program of yours (a script, an importer, another system) to reading and changing data of
an eclume account through the v1 API. It holds for any eclume server. The exact names of routes,
parameters and fields are in the **API reference**, which every server serves in the version it runs:
`https://<server>/referencia-api.html`. The rules behind the contract are in
[contrato-v1.md](../standards/api/contrato-v1.md).

In the examples, `https://eclume.example:8443` is the address of your server.

## 1. Trust the server's certificate

eclume uses its own CA, which the system does not know. Download the root and check the fingerprint
against the one the public descriptor publishes:

```bash
curl -k -o eclume-root.crt https://eclume.example:8443/downloads/eclume-root.crt
openssl x509 -in eclume-root.crt -outform der | sha256sum
curl --cacert eclume-root.crt https://eclume.example:8443/api/v1/server
```

The SHA-256 of the DER must be the `ca_sha256` of the `GET /api/v1/server` response (also check with
whoever administers the server). From then on, always use `--cacert eclume-root.crt` (or the equivalent
in your HTTP library) and never turn verification off. During a rotation, the descriptor also carries
`ca_next_sha256`, and the next root is at `/downloads/eclume-root-proxima.crt`.

## 2. Create an access token

On the web, open **Tokens de acesso** and click **Novo token**. Give it a name that says which program
uses it, choose the scopes and the validity (30 days, 90 days or never). The token (`eclp_…`) appears **only
once**: keep it in the program's vault, never in code. Creating a token is web-only, with the account's
session: a token does not create another.

## 3. Choose the scopes

Give the program only what it uses. The screen offers four groups and, in **Escopos individuais**, each
scope on its own:

| Group | Scopes |
|---|---|
| Buscar e ler gravações | `recordings:read`, `transcripts:read` |
| Ler e editar resumos | `summaries:read`, `summaries:write` |
| Editar campos e tags | `recordings:write` |
| Excluir gravações | `recordings:delete` |

Outside the groups are `transcripts:write` (renaming speakers and correcting utterances), `people:read` and
`people:write`. A transcript importer lives on `transcripts:read` and
`people:read`. Each operation in the reference says the scope it asks for; without it, the response is **403**
`insufficient_scope` with `required_scopes`.

## 4. Authenticate

Send the token on every request:

```bash
curl --cacert eclume-root.crt \
  -H "Authorization: Bearer $ECLUME_TOKEN" \
  https://eclume.example:8443/api/v1/me
```

With `Authorization` present, the server never uses a cookie: the program needs no CSRF. An invalid, revoked or
expired token is **401** `unauthorized`; session-only routes (create token, pairing
code, voice) answer **403** `session_required`.

## 5. Page by cursor

Every listing returns `{items, next_cursor}`. Ask for the next page with the received cursor until
`next_cursor` comes back `null`:

```bash
curl --cacert eclume-root.crt -H "Authorization: Bearer $ECLUME_TOKEN" \
  "https://eclume.example:8443/api/v1/recordings?limit=100"
curl --cacert eclume-root.crt -H "Authorization: Bearer $ECLUME_TOKEN" \
  "https://eclume.example:8443/api/v1/recordings?limit=100&cursor=<next_cursor>"
```

`limit` goes from 1 to 200. The cursor is opaque and valid only for the ordering (`sort`) that produced it: do not
build it or keep it across orderings.

## 6. Sync by `since`

To bring only what changed, use `?since=` on the incremental listings (`GET /transcripts`,
`GET /recordings`):

1. The first time, walk everything and keep the greatest `updated_at` you saw.
2. On the following ones, ask for `?since=<that updated_at>` and walk all the pages.
3. `since` is **inclusive** (`updated_at >= since`): the last item of the previous round comes back.
   Deduplicate by `id` + `revision` — the `revision` goes up on each edit, so the same `id` with a
   greater `revision` is a new version, and the same pair is a repeat.

A new or redone summary also moves the transcript's and the recording's `updated_at`, so
`since` notices it.

## 7. Read the errors

Every error comes in `application/problem+json` (RFC 9457) with a stable `code`. Decide by the `code`,
never by the `title`, which is text for people:

```json
{"type": "https://eclume.dev/problems/insufficient-scope", "title": "Escopo insuficiente",
 "status": 403, "code": "insufficient_scope", "required_scopes": ["summaries:write"]}
```

- **404** does not say whether the resource does not exist or does not belong to the account.
- **422** `validation_failed` carries `errors[]` with the field and the reason.
- **403** `quota_exceeded` carries `quota`, `limit` and `used`.
- **429** `rate_limited` carries the `Retry-After` header (seconds): wait that long before
  retrying. Logins and pairing have an attempt limit per IP; the account also has a ceiling on
  summaries in the queue.
- **500** `internal_error` carries no detail; the `X-Request-ID` header is what the administrator
  looks for in the log.

## 8. Connect an AI assistant through MCP

The MCP server is at `https://eclume.example:8443/mcp` (outside `/api/v1` and the reference) and uses
the same token, with the same scopes. On the web, **Conexão MCP** shows the address, creates the token with
the groups above and builds the `claude mcp add` command for Claude Code; in Claude Desktop, add
a custom connector with the address and the token. The assistant's machine also needs to trust
the CA from step 1. Leave **Excluir gravações** unchecked if the assistant does not need to delete anything:
the text of a transcript is data, never an order.

## To test without a server

The contract has a mock (Prism) that answers with the fixtures' examples, useful for writing the
client before having an account on a server; see [contracts/README.md](../../contracts/README.md).
