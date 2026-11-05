---
title: Create an access token
topic: conectar
pages: [tokens, mcp]
related: [revoke-token, connect-mcp-assistant, link-a-device]
terms: [token, scope, scopes, expiry, key, API, access, lumea]
order: 2
updated: 2026-10-01
---
An access token lets another program use eclume on your behalf, with the permissions you choose.
Create it in [Access tokens](/tokens) or, for an AI assistant, in
[MCP connection](/config/mcp).

## The scopes

Scopes come in four groups:

- **Search and read recordings:** list, search and read recordings and transcripts.
- **Read and edit summaries:** read the summary, edit it and ask for a new one.
- **Edit fields and tags:** change the title, tags and your fields.
- **Delete recordings:** erase recordings. It comes unticked.

**Individual scopes** holds the permissions outside the groups, such as reading the people directory.
An integration like lumea uses only `transcripts:read` and `people:read`.

## Expiry

Choose 30 days, 90 days or Never. An expired token shows as **Expired** and stops working.

## The token shows once

After creating it, eclume shows the token a single time. Copy it and keep it somewhere safe, such as
a password manager. Lost it? Revoke it and create another: see [Revoke a token](/ajuda/revoke-token).

## For developers

The API routes, the scope each one asks for and the shape of the responses are in the
[API reference](/referencia-api.html), served by eclume itself in the version it runs.
Send the token in the `Authorization: Bearer <token>` header.
