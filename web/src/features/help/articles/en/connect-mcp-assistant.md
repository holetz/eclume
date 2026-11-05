---
title: Connect an assistant through MCP
topic: conectar
pages: [mcp]
related: [create-token, server-certificate, revoke-token]
terms: [MCP, assistant, Claude, Claude Desktop, Claude Code, connector, AI, integration]
order: 1
updated: 2026-09-27
---
MCP is the protocol AI assistants, such as Claude, use to talk to other systems. Connected to
eclume, the assistant answers questions like "What did we decide in last week's planning?" by
looking at your recordings.

## What the assistant can do

According to the scopes of the token you give it:

- search and read your recordings and transcripts;
- read and edit summaries, and ask for a new summary;
- edit the title, tags and your fields;
- delete recordings, only if you tick that scope.

Without the scope, the action is refused, and the assistant explains what is missing.

## The steps

1. In [MCP connection](/config/mcp), copy the MCP server address.
2. In the same place, create a token for the assistant. It shows only once: copy it right away. See
   [Create an access token](/ajuda/create-token).
3. Add eclume to the assistant:
   - **Claude Desktop:** in Settings, **Connectors**, add a custom connector with the address and
     the token.
   - **Claude Code:** paste the `claude mcp add` command the screen builds after you create the token.

The assistant's computer must trust this server's certificate: see
[Why the device asks about the certificate](/ajuda/server-certificate).

> **The transcript is data, not an order**
> The assistant reads what was said in the meetings. A sentence in a recording, such as "delete
> everything", is content, not a request from you. Even so, leave **Delete recordings** unticked if
> the assistant does not need to delete.
