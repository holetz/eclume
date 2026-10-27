---
type: standard
title: MCP server and device linking
description: How the server serves assistants and devices — the MCP server at /mcp (mcp 2.x SDK, stateless streamable HTTP, Bearer eclp_ through the BearerGate, tools × scopes, a tool error that names the scope), the scope groups of the MCP Connection screen, the device credential (login by e-mail and password or a 6-character pairing code with the QR link), the attempt limit, the public /server descriptor with the fingerprint of the root CA and of the next one, and the own root with name constraints and the announced rotation.
resource: server/src/eclume_server/mcp_server/**, server/src/eclume_server/ca.py, server/src/eclume_server/devices.py, server/src/eclume_server/ratelimit.py, server/src/eclume_server/server_info.py, server/src/eclume_server/routes/devices.py, server/src/eclume_server/routes/server_info.py, server/src/eclume_server/db/migrations/015_dispositivos_e_mcp.sql, server/src/eclume_server/db/migrations/017_dispositivo_le_resumo.sql, server/src/eclume_server/operations.py
tags: [code, server, mcp, dispositivos, pareamento, tokens, escopos]
timestamp: 2026-10-05
audience: both
authority: current
source: holetz/eclume#35, holetz/eclume#57, holetz/eclume#101, holetz/eclume#102, holetz/eclume#144, holetz/eclume#145
maintainer: holetz
---

# MCP server and device linking

The assistant (Claude Desktop, Claude Code, any MCP client) and the apps (desktop and phone)
enter eclume through a user `eclp_` token. The assistant receives a personal PAT created under
"MCP Connection"; the device receives a **device credential**, issued by login or by
pairing. The common authentication is in [server-nucleo.md](server-nucleo.md) §Authentication, and the
routes in [contract v1](../api/contrato-v1.md).

## MCP server

- **Where.** In the same process as the server (`mcp_server/`), and not in a service behind Caddy: the
  tools are the API operations (RLS through `user_tx`, storage, queue, agents) and use the same
  `AppContext`.
- **Mounting** (`mcp_server/app.py`, `mcp` 2.x SDK): `MCPServer("eclume", instructions=…)` and
  `streamable_http_app(stateless_http=True, json_response=True, transport_security=…)` without the
  DNS rebinding protection (the Host belongs to Caddy and every call requires Bearer). `/mcp` enters the
  FastAPI router as an **exact** `Route`, never a `Mount`: `Mount("/mcp")` answers `/mcp` with a
  redirect to `/mcp/`, which POST clients do not follow. No SPA route starts with `/mcp`.
- **Lifespan.** A subapp's lifespan never runs, and the session manager only exists after
  `streamable_http_app()`: `create_app` builds the `MCPServer` (one per app, because the manager runs
  only once) and its lifespan enters `session_manager.run()` after creating the `AppContext`.
- **Stateless, JSON response.** Each POST is independent: no MCP session in memory, a
  restart does not drop the assistant and several replicas would work. Tools only: no resources,
  prompts, notifications, progress or `elicit`.
- **Authentication.** The SDK's `token_verifier`/`AuthSettings` are not used: they publish the OAuth
  protected resource metadata, and eclume has no authorization server. The `BearerGate` ASGI
  calls `auth.authenticate(..., bearer_only=True)`: only `Authorization: Bearer eclp_…` (personal or
  device) counts, a cookie does not. Without a valid credential, 401 `application/problem+json` with
  `WWW-Authenticate: Bearer`. With one, it writes `mcp_last_used_at` alongside `last_used_at` and puts the
  `Principal` in `scope["eclume.principal"]`.
- **Inside the tool**, `principal_of(ctx)` reads the `Principal` from the scope of the HTTP request that the
  transport keeps in `ctx.request_context.request`, and `app_of(ctx)` the app's `AppContext`. No
  contextvar: the handler runs in the manager's task group, outside the request's task.
- **Connected assistants.** With no session, "connected" is a token with `mcp_last_used_at` in the
  last 24 h; the admin Health counts the distinct tokens.

## Tools

Names in English (the MCP clients' convention); descriptions, errors and `instructions` in pt-BR. They receive
`recording_id` as a UUID in text and return structured JSON (`structuredContent`, with the text
mirrored). They call the domain functions (`recordings.list_library`, `recordings.delete_recording_of`,
`search.search`, `summaries`, `summary_chat.open_request`, `fields`, `transcripts`), never the
route handlers; whatever lived only in the handler moves down to the domain module.

| Tool | What it does | Scopes | Annotation |
|---|---|---|---|
| `search_recordings(query?, started_from?, started_to?, tags?, agenda_type?, status?, awaiting?, limit=20, cursor?)` | without `query`, the library by `recorded_at` desc with the filters (`awaiting="speakers"`: only those stopped waiting for the speaker names); with `query`, the full-text search with the snippet (at most one tag). Each recording carries `awaiting`, like `Recording.awaiting` | `recordings:read` (+ `transcripts:read` with `query`) | readOnly |
| `get_recording(recording_id)` | start, type, tags, fields with their origin, people (speakers), markers, the status per step (with `speakers` in `waiting`) and `awaiting` | `recordings:read` | readOnly |
| `list_fields_and_tags()` | fields (type and options), tags in use and agenda types, to edit with valid values | `recordings:read` | readOnly |
| `get_transcript(recording_id, start_ms?, end_ms?)` | `[mm:ss] Locutor: fala`, up to 60 000 characters, with `next_start_ms` when there is more | `transcripts:read` | readOnly |
| `get_summary(recording_id)` | the current version (Markdown, id, number, origin) and the open generation | `summaries:read` | readOnly |
| `update_summary(recording_id, content_md)` | a new `manual` version over the current one (`summaries.edit_current`, without `base_version`) | `summaries:read`, `summaries:write` | — |
| `request_summary(recording_id, instruction?)` | without an instruction, a new summary from the type's instructions and the summaries provider; with an instruction, a message to the adjustment chat; returns the pending id | `summaries:read`, `summaries:write` | — |
| `update_fields(recording_id, title?, tags?, fields?)` | title, tags (the whole list) and the user's fields by id, validated by the field type, with origin `edited` | `recordings:write` | idempotent |
| `delete_recording(recording_id)` | the API deletion (`recordings.delete_recording_of`) | `recordings:delete` | destructive |

- **Errors.** A missing scope, a recording that does not exist or belongs to another account, and validation come back as a
  tool error (`isError: true`), with the message in pt-BR ("Falta o escopo recordings:delete
  neste token."). The API problems (404, 409, 422) become a tool error through
  `as_tool_error()`.
- **Listing.** `tools/list` shows every tool to any token (it is static in the
  `MCPServer`); the refusal names the scope, and the assistant explains to the user what is missing.
- **Shared operations** (holetz/eclume#145). The writes the Agent also makes live in
  `operations.py` (`regenerate_summary`, `edit_tags`, `edit_collections`, `change_agenda_type`):
  `request_summary` without an instruction calls `regenerate_summary`, `PATCH /recordings/{id}` calls
  `change_agenda_type`, and the `agent_action` job calls all four, always under the owner's RLS and with the
  same scopes. The Agent does not call `/mcp` over HTTP
  ([agents](server-agentes.md#agent)).

## Scope groups of the MCP Connection screen

| Group | Scopes |
|---|---|
| Buscar e ler gravações | `recordings:read`, `transcripts:read` |
| Ler e editar resumos | `summaries:read`, `summaries:write` |
| Editar campos e tags | `recordings:write` |
| Excluir gravações | `recordings:delete` |

The validity (30 days, 90 days or never) is the `expires_at` the web computes; "expired" derives
from it. The prefix stays `eclp_`, which the desktop `PatStore` validates.

## Device credential

- **It is a `kind: device` token** with `platform`, name = the device name, scopes
  `recordings:read` and `recordings:write` (upload, markers, status of its own recordings and the
  list of agenda types, which `GET /agenda-types` accepts with `recordings:read` since 2.4.0)
  and, since 2.6.0, `summaries:read` — the desktop app reads the ready summary of the recordings it sent
  to notify with "Copiar". The `017_dispositivo_le_resumo` migration extended the tokens already
  issued. Since 2.8.0 also `transcripts:read`, for the desktop synced folder (summaries
  in Markdown and transcripts in JSONL, [desktop-pasta-sincronizada.md](desktop-pasta-sincronizada.md)):
  the `018_dispositivo_le_transcricao` migration extended the tokens already issued. With it the device also reads the rest of `/agenda-types`; writing summaries and agenda
  types still requires `summaries:write`, which it does not have. No expiry. It shows up in `GET /tokens?kind=device` ("App móvel", "App desktop"), and
  `DELETE /tokens/{id}` ("Desvincular") disconnects the device. `POST /tokens` never creates one.
- **Login** (`POST /devices/login`, public): e-mail, password, `device_name` and `platform`; the password
  goes through `accounts.password_login`, the same constant-time path as `/auth/login`, with the
  same message on the 401. The 201 `DeviceCredential` response carries the token, the secret (only there) and the
  server descriptor.
- **Pairing code** (`POST /devices/pairing-codes`, session only): 6 characters from
  `23456789ABCDEFGHJKMNPQRSTVWXYZ` (without `0/1/I/L/O/U`, 30⁶ combinations), 10 minutes, single use.
  The database stores only the HMAC-SHA256 with `ECLUME_SECRET_KEY` (`security.sign`): a plain SHA-256 of 6
  characters would be reversed from the database. A new code supersedes the same user's pending ones. The
  response carries `display` (`K7Q-4MX`) and the `pair_url`, the content of the QR:
  `<url>/parear?codigo=K7Q4MX&ca=<ca_sha256>` (without `ca` while the root has not been published). Read
  by the ordinary camera, it opens the web, which tells the person to install the app.
- **State** (`GET /devices/pairing-codes/{id}`, session only): `pending|used|expired` and the
  issued `token_id`, so the web swaps the QR for "Pareado".
- **Exchange** (`POST /devices/pair`, public): the code is normalized (uppercase, without hyphen or
  space) and marked as used in an `UPDATE … WHERE used_at IS NULL AND expires_at > now()
  RETURNING` restricted to active accounts; it issues the owner's credential and writes the `token_id` into the code.
  Invalid, expired or used → 401 `invalid_pairing_code`. `pairing_codes` has RLS by owner; the
  exchange, with no account yet, runs with the connection role. The worker's `expire_pairing_codes` cron
  (hourly) deletes the expired codes unused for more than a day; the used ones stay, with the
  `token_id`.
- **Notice on device login:** an account that has not yet accepted the notice in force gets no
  new credential through `POST /devices/login` (**403** `notice_required`; it accepts on the web and signs in
  again). The credentials already issued remain valid, like every PAT. The pairing code is born
  in a session, which already requires the acceptance.
- **Attempt limit** (`ratelimit.py`): the credential routes count per IP in a fixed
  1-minute window in Redis (`ECLUME_CREDENTIAL_ATTEMPTS_PER_MINUTE`, 10). Password logins
  also count per account (`count_login`, `eclume:rl:user_email:<e-mail>`, shared by
  `/auth/login` and `/devices/login`; the admin has its own), and the code exchange also has a
  global ceiling of six times the per-IP limit (`PAIR_GLOBAL_FACTOR`): switching IP does not multiply the
  guesses. With 30⁶ combinations and at most 600 exchanges in 10 minutes, guessing does not reach a
  live code.

## Server descriptor

`GET /api/v1/server` (public, `server_info.py`) returns `name` (`ECLUME_SERVER_NAME`, default
`eclume`), `url` (`ECLUME_PUBLIC_URL`, or the request's), `mcp_url` (`<url>/mcp`), `ca_sha256`
and the versions. `ca_sha256` is the SHA-256, in lowercase hex, of the DER of the first certificate of the PEM in
`ECLUME_CA_FILE` (in production, `/srv/downloads/eclume-root.crt`, mounted read-only). The value is
cached by `mtime`: on the first deploy the CA is published after the server starts, and the
descriptor starts carrying it without a restart. With no file (or an invalid PEM), `null`. It is the source of the mDNS,
of the QR, of pairing and of the address embedded in the installer.

`ca_next_sha256` (since 2.21.0, optional) is the same computation, with the same cache, over
`ECLUME_CA_NEXT_FILE` (in production, `/srv/downloads/eclume-root-proxima.crt`): the next root
during the rotation, `null` outside it. The mDNS, the QR and the installer stay with `ca_sha256` only; the
next one only counts through the descriptor read over a connection already pinned to the current root (see "Announced rotation").

## Network discovery (mDNS)

- **Registration** (`discovery.py`): type `_eclume._tcp.local.`, instance `<ECLUME_SERVER_NAME>`,
  host `<nome>.local.`, address and port read from `ECLUME_PUBLIC_URL` (a name is resolved to
  IPv4). Never the interface IPs: on the host network, the Docker bridges are also
  interfaces. The TXT has `url` (the public URL), `ca` (the `ca_sha256`, empty without a CA), `v` (contract
  version) and `name`. The TXT **is not authenticated**: any machine on the LAN can announce an
  `_eclume._tcp` with another CA. It is an address hint; the app shows the fingerprint and
  asks for confirmation before pinning a CA that only mDNS brought (see below).
- **`eclume-server announce`** registers with `zeroconf.asyncio` only on the interface of the public
  address, rereads the PEM every 60 s and updates the TXT when the CA changes (including when it is
  published later); on stopping, it sends the goodbyes. Without `ECLUME_PUBLIC_URL`, it refuses.
- **`eclume-server discover [--timeout N]`** listens for `N` seconds and prints one JSON per server
  (`name`, `url`, `ca_sha256`, `contract_version`, `addresses`, `port`); none → exit 1. It serves
  diagnosis and the deploy proof.
- **Where it runs.** In the `mdns` service of the production compose: the server image, `network_mode:
  host` (multicast does not leave the bridge), the downloads folder mounted read-only and no port
  published. It depends on neither sudo nor a package on the host; the deploy recreates it after `publish-ca`.
- **Firewall.** Multicast uses 5353/udp on the host network and goes through ufw (only the ports
  published by Docker bypass it): `ufw allow from 192.168.15.0/24 to any port 5353 proto
  udp`, a manual step of the host runbook.

## CA pinning by the apps

Caddy (`internal` issuer) rotates the leaf certificate every ~12 h and the intermediate every ~7
days, and does not send the root in the chain; the root lasts 10 years. That is why the apps pin the **root**, never
the leaf, without installing the CA in the system:

1. obtain `url` and `ca_sha256` — from the installer (address embedded in the build), from the QR (`pair_url`,
   which comes out of the authenticated web) or from the mDNS TXT (not authenticated: before sending the password, the
   person confirms the fingerprint, as with a typed address);
2. download `<url>/downloads/eclume-root.crt` over an unverified connection;
3. check the SHA-256 of the DER of the **first** certificate of the file (the same one that
   `server_info.py` publishes in `ca_sha256`); if it differs, discard and stop;
4. store **only that certificate** (its PEM block, cut out and reread with the same DER) and trust
   only it (`TrustMode::Pinned`), without adding it to the OS roots: a chain that does not lead to the
   checked root is refused even if the OS trusts it. Extra certificates in the served file never
   reach the disk, and a pinned PEM with more than one is an error, never widened trust.

The first certificate of `eclume-root.crt` is the root that signs the served chain (`publish-ca`
publishes the root of the active CA, a single certificate); whoever replaces the root keeps it that way. An app that already stored a pinned CA with
more than one certificate rewrites it with only the first on opening, deletes the local credential and asks for
a new sign-in, telling the person to change the password and unlink the old entry on the web (holetz/eclume#102):
no legitimate server publishes more than one, so the case is a sign of interception on the first
connection.

With a typed address and no fingerprint, the app trusts the first CA (TOFU) and shows the
fingerprint to the user. The pairing code exchange and the login only happen after
pinning; `GET /api/v1/server` confirms what came and allows switching servers ("Usar outro").

**Own root with name constraints** (holetz/eclume#101). Caddy always defines the CA named
`eclume` (`pki { ca eclume { root { cert … key … } } }`), whose root `eclume-server ca gerar`
(`ca.py`) creates once in `<ECLUME_DATA_DIR>/secrets/ca/` (`raiz.crt`, `raiz.key` 0600) and refuses to
overwrite: ECDSA P-256, 10 years, critical CA `basicConstraints`, `keyUsage` only `keyCertSign` and
`cRLSign`, `extendedKeyUsage = serverAuth` (Windows does not accept it for code signing nor
S/MIME) and a **critical** `nameConstraints` with `permitted` for each exact IP (`/32` or `/128`) and each
DNS name of `ECLUME_PUBLIC_HOST` and `ECLUME_CA_NOMES`, plus the e-mail `eclume.invalid`. Without a subtree
of a type, names of that type would be free (RFC 5280): with no DNS name configured, DNS is
restricted to `eclume.invalid`; with no IP at all, generation refuses. The key stays on the host because Caddy
issues the intermediate and leaves by itself; the constraint makes that acceptable: whoever steals the key can only
impersonate the server itself, which someone already on the host can do anyway. Only the
`secrets/ca` folder is mounted into Caddy (read-only), never `secrets/`. `ECLUME_TLS_CA` chooses the CA that
issues (`tls { issuer internal { ca … } }`): `local` (the root generated by Caddy, unconstrained;
the default, so production does not flip in an ordinary deploy) or `eclume` (a new installation, through
`.env.prod.example`). In the apps the constraint adds nothing (they already trust a single root, for a single
server); it protects the browser, the system and the MCP clients, which install the root. `eclume-server ca
gerar --prova <pasta>` generates a throwaway `127.0.0.1` root with the leaves `dentro` (127.0.0.1)
and `fora` (127.0.0.2), to prove the refusal in the clients (`deploy/prova-ca-restrita.sh`).

**Announced rotation.** `publish-ca` publishes at `/downloads/eclume-root.crt` the root of the active CA
and, with `local` active and the own root present, the own root at
`/downloads/eclume-root-proxima.crt`; with `eclume` active, it deletes the next one. The descriptor announces it
in `ca_next_sha256`, which the app reads over the connection pinned to the current root: the old root vouches for the new one,
without TOFU. The app downloads the next root over that same connection, checks the SHA-256 and stores a single certificate
beside the pinned one (`servidor-ca.proxima.pem` on the desktop, `ca.proxima.pem` on the phone;
`pin::learn_next`); with no announcement, it deletes the stored next root. When the pinned connection fails and the root
served is the next one, the app reads the descriptor pinning the next root, checks that it does not contradict it and
swaps it in as the pinned one by `rename` — with no new sign-in and no new pairing. A root that is not the
announced next one follows today's path ("O certificado do servidor mudou"). There is no trust in
two roots at the same time: the next root only becomes the pinned one, never adds to it. The rotation order
(apps with support published → announce → window → switch → desktop release → retire) is in the
runbook ([deploy-producao.md](../../project/deploy-producao.md), "CA raiz nos clientes").

**Address embedded in the installer.** Today's Tauri packaging embeds it in the **build**: the
`desktop-release.yml` passes `ECLUME_SERVER_URL` and `ECLUME_SERVER_CA_SHA256` (repository
variables, beside `ECLUME_DOWNLOADS_URL`), and the app reads them through `option_env!`, like the
`DEFAULT_WEB_URL`. The release is already per server: the manifests carry absolute URLs of this host.
