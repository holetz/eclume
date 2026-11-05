---
title: Revoke a token
topic: conectar
pages: [tokens]
related: [create-token, link-a-device, connect-mcp-assistant]
terms: [revoke, cancel, token, expired, turn off, unpair]
order: 3
updated: 2026-09-27
---
Revoking a token cuts off whoever uses it, right away.

## How to revoke

In [Access tokens](/tokens), use **Revoke** on the token's row and confirm. The revoked token stays
at the end of the list, faded, so you know it existed.

## When to revoke

- An assistant or an integration is no longer used.
- The token may have leaked, like in a file sent by mistake.
- You do not remember what a token is for. The **Last used** column helps you decide.

## Expired tokens

A token past its expiry shows as **Expired** and no longer works. You do not need to revoke it.

## Device tokens

The desktop app and the phone receive a token of their own when they sign in, marked as **Device** in
the list. Revoking a device token disconnects the app on that device, the same as **Unpair** in
[Desktop app](/app-desktop) or [Mobile app](/app-movel). Recordings that have not been uploaded yet
stay on the device until it signs in again.
