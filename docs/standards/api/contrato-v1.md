---
type: standard
title: API contract v1
description: The conventions of the eclume API v1 — one account per user, user session and PAT with scopes, a separate admin session for /admin/*, device credential and public descriptor, /mcp outside /api/v1, RFC 9457 errors, cursor pagination, S3 multipart upload with hash dedup, transcript in JSON Schema, the browsable reference generated from the bundle and served by the web at /referencia-api.html — and the rule that v1 only evolves additively, with the redesign's 2.x line as the single exception.
resource: contracts/**, deploy/docker-compose.mock.yml, server/**
tags: [api, contrato, openapi, pat, upload, evolucao]
timestamp: 2026-10-05
audience: both
authority: current
source: holetz/eclume#3, holetz/eclume#15, holetz/eclume#26, holetz/eclume#32, holetz/eclume#34, holetz/eclume#35, holetz/eclume#41, holetz/eclume#100, holetz/eclume#93, holetz/eclume#99, holetz/eclume#98, holetz/eclume#117, holetz/eclume#118, holetz/eclume#119, holetz/eclume#116, holetz/eclume#121, holetz/eclume#101, holetz/eclume#127, holetz/eclume#128, holetz/eclume#144, holetz/eclume#142, holetz/eclume#145
maintainer: holetz
---

# API contract v1

The contract lives in `contracts/`: `openapi-v1.yaml` and `transcript.schema.json` are the source
of truth, `fixtures/` holds the examples and `openapi-v1.bundled.yaml` is the single-file
derivative that the mock (Prism) and the type generators read. The server **conforms** to the
contract; the contract is never generated from the code. The usage manual (mock, lumea, desktop,
mapping to `transcricao.md`) is in [contracts/README.md](/contracts/README.md).

## Conventions

- **Prefix and formats.** Everything under `/api/v1`, except the MCP server at `/mcp` (Model
  Context Protocol JSON-RPC, outside the OpenAPI; see
  [server-mcp-e-dispositivos.md](../code/server-mcp-e-dispositivos.md)). Dates in RFC 3339 UTC, durations in integer
  milliseconds (`*_ms`), ids in UUID; speakers have an id `S<n>` unique within the transcript.
- **One account per user.** There is no organization: each account sees and changes only what is
  its own. The account is born at open sign-up (`POST /auth/signup`), with acceptance of the notice
  in force; an account without the current acceptance gets `notice_required: true` in `GET /me`
  and accepts through `POST /me/notice`. Since 2.3.0, that account's **session** gets **403**
  `notice_required` on every user route except `GET /me`, `POST /me/notice` and `/auth/*`; the PAT
  is not blocked (the desktop and the lumea of migrated accounts keep working, and the web is what
  asks for the acceptance).
- **Authentication.** Three schemes.
  - **User session** (`sessionCookie`): cookie `eclume_session` (HttpOnly, Secure,
    SameSite=Lax) with double-submit CSRF (`X-CSRF-Token` = cookie `eclume_csrf`) on mutating
    methods.
  - **PAT** (`pat`) in `Authorization: Bearer eclp_<segredo>`, stored only as a hash and shown
    once. `Token.kind` tells the **personal** PAT (`personal`, created at `POST /tokens`) from the
    **device credential** (`device`, with `platform`), which is only born from
    `POST /devices/login` (e-mail and password) or `POST /devices/pair` (pairing code) and
    answers like any PAT; `GET /tokens?kind=` separates the two lists.
  - **Admin session** (`adminSessionCookie`): an admin account separate from user accounts,
    opened by `POST /admin/auth/login`. Cookie `eclume_admin_session` (HttpOnly, Secure,
    SameSite=Strict, `Path=/api/v1/admin`) and CSRF by `X-CSRF-Token` = cookie `eclume_admin_csrf`.
- **The admin boundary.** `/api/v1/admin/*` (except the login) declares only `adminSessionCookie`:
  a user session, a PAT or nothing there give **401** `unauthorized`. The admin session is ignored
  on any other route. The admin sees only the platform (settings, secrets, agents, accounts,
  health); no admin route returns user content. Since 2.15.0, `AdminUser` carries the account's
  usage (`usage`) and the quota override (`quotas`, only the overridden fields, or `null`),
  `PATCH /admin/users/{id}` accepts `quotas` (replaces the whole override; `null` returns to the
  default) with `active` optional, and `DELETE /admin/users/{id}` (204; nonexistent, 404) deletes
  the account like `POST /me/delete`, without the password, and frees the e-mail. Since 2.18.0,
  `POST /admin/users/{id}/password-reset` (201 `PasswordResetLink`; deactivated account, **409**
  `conflict`) generates the account's password reset link; the admin never sees nor sets the
  password.
- **PAT scopes:** `recordings:read`, `recordings:write`, `recordings:delete` (2.3.0, recording
  deletion), `transcripts:read`,
  `transcripts:write`, `people:read`, `people:write`, `summaries:read`, `summaries:write`. None
  implies another; the operation lists in the `pat: [...]` requirement every one it demands. When
  one of several is enough, the operation declares one `pat` requirement per scope and the route
  uses `requires_any` (since 2.4.0, `GET /agenda-types` accepts `summaries:read` or
  `recordings:read`, so the device credential can pick the type on stop). The device credential
  has `recordings:read`, `recordings:write`, `summaries:read` (2.6.0) and `transcripts:read`
  (2.8.0, the desktop's synced folder). A session has all of the user's permissions.
- **Agent (2.23.0, `agent`):** `GET`/`POST /agent/sessions` (the conversations, by cursor, from
  the latest activity backwards; create, with an optional title), `GET`/`PATCH`/`DELETE
  /agent/sessions/{session_id}` (the conversation with its messages and the unsent attachments;
  rename; delete), `POST /agent/sessions/{session_id}/files` (multipart, 201; .txt, .md, .csv, .pdf
  and .docx up to 10 MB, 415 `unsupported_media_type` otherwise, 409 `too_many_files` above 20 per
  conversation), `DELETE .../files/{file_id}` (only an unsent attachment; a sent one is 409), `POST
  .../messages` (202 with `question` and `answer`; 409 with another answer open in the
  conversation, 429 with two in the account, the agent's 24 h quota), `GET
  .../messages/{message_id}` (poll until `done` or `failed`, with `agent_expired` after 15 minutes
  open) and `GET /agent/files/{file_id}/content` (the file as an attachment). All with
  `summaries:read`, like the chat over the base; the `transcripts:read` scope applies to the tools.
  Another account is 404. Additive: `/base-chat` stays the same and becomes `deprecated`.
- **Agent skills and actions (2.24.0, `agent`):** `GET /agent/tools` (the tool catalog, with the
  nature `read`, `produce` or `action`), `GET`/`POST /agent/skills` and
  `GET`/`PATCH`/`DELETE /agent/skills/{skill_id}` (the skills: name `/nome` unique in the account,
  409 `skill_exists`; up to 50; a null `allowed_tools` allows all), all with `summaries:read`.
  `AgentMessageCreate.skill` (or `/nome` at the start of the message) picks the skill (422 if
  nonexistent or switched off) and `AgentMessage` gains `skill` and `actions` (the answer's
  proposals). `GET /agent/actions` (the audit, by cursor), `GET /agent/actions/{action_id}`, `POST
  .../confirm` (202, idempotent; requires `summaries:write` for `regenerate_summaries` or
  `recordings:write` for the others; 409 `action_expired` or `action_cancelled`) and `POST
  .../cancel` (only from `proposed`; 409 `action_not_proposed`). Additive: nothing changes for
  those who do not use it.
- **Speakers on retranscription (2.25.0, `recordings`):** `RetranscribeRequest` gains
  `min_speakers` and `max_speakers` (integers from 1 to 30, optional; 422 if the minimum exceeds the
  maximum). The pair applies only to the requested revision and overrides the admin's limits.
  Without a request, the voice note (`kind: note`) is transcribed with 1 speaker. Additive: those
  who do not send the fields see no change in meetings.
  **Ceiling of 30 (2.26.0):** the same `maximum` applies to `min_speakers`/`max_speakers` of the
  admin's `diarization` block; above it, or with a boolean instead of the number, the answer is
  422. The ceiling is the product's (institutional meetings) and sits below diarization's `uint8`,
  which overflowed at 256 after spending the GPU. A deliberate exception to "tightening
  validation": the field was hours old and every value above the ceiling already ended in
  `DIARIZATION_FAILED`.
- **Bounded person name (2.27.0, `people`):** `PersonCreate.name` and `PersonPatch.name` gain
  `maxLength: 200`; above that the answer is 422. The vocabulary sent to the ASR has 400 characters
  in total, and a single name cannot consume half of it. Names already stored above the ceiling
  stay readable and editable: only new writes are bounded. A deliberate exception to "tightening
  validation": a name of more than 200 characters is not a name, and the server now skips, instead
  of stopping at, the name that does not fit in the vocabulary.
- **Size ceilings on writes (2.28.0, `input-limits`):** fields that only had the request body's
  limit gain a ceiling, and above it the answer is 422: `SegmentPatch.text` (20000 characters);
  `PersonCreate`/`PersonPatch` `notes` (4000) and `email` (254); `CollectionCreate`/
  `CollectionPatch` `name` (200) and `description` (2000); `RecordingPatch` `tags` (50 items of up
  to 64), `collection_ids` (100) and `metadata` (50 entries, keys of up to 64 and values of up to
  1000); `AgentSkillCreate`/`AgentSkillPatch` `allowed_tools` (100 items of up to 64). Values
  already stored above the ceiling stay readable, and a PATCH that does not send the field is not
  affected: only new writes are bounded. A deliberate exception to "tightening validation", field
  by field, as in 2.27.0: a value above the ceiling was never legitimate and today only inflates
  listings, summaries, search, embeddings and the Agent's prompts. Minor.
- **Audio retention (2.29.0, `audio-retention`):** `GET`/`PATCH /me/audio-retention` (read with
  `recordings:read`, write by session only) carry `{days, max_days, effective_days}`: `days` is the
  account's choice in days (1 to 3650, `null` is off, the default), `max_days` is the admin's
  ceiling and `effective_days` is `days` capped by it. `AdminSettings` and `AdminSettingsPatch` gain
  the `retention` block with `audio_max_days` (`null` is no ceiling; it never deletes anything for
  an account that left retention off). `Recording` gains `audio_deleted_at` (date-time or `null`,
  always sent, not in `required`). A recording whose audio was deleted answers 410
  `audio_deleted` on `GET /recordings/{id}/audio` and on the signed media URL, and 409
  `audio_deleted` on every route that starts a new revision (retranscribe, retry). Transcript,
  summary and chat stay. All additive. Minor.
- **Anonymized examples (2.27.1, `fixtures`):** the e-mails, names and the `device_name` example
  of the fixtures and of the contract become neutral, with no real person or organization. Only
  examples and descriptions change: no schema, route or validation. Patch, with no effect for
  clients.
- **English descriptions (2.29.1, `contracts`):** the `description`, `summary` and `title` texts
  of `openapi-v1.yaml` and the `description` texts of `transcript.schema.json` are translated to
  English. Wire names (paths, fields, enum and `code` values, scopes, tags, components and example
  keys) stay as they were. Only descriptions change: no schema, route or validation. Patch, with no
  effect for clients.
- **Account locale and coded errors (2.30.0, `i18n`):** `GET`/`PATCH /me/locale` (read with any
  valid credential, write by session only) carry `{locale, effective, default, supported}`: `locale`
  is the account's choice (`en`, `pt-BR` or `null`), `effective` is the locale in force (the
  account's, else `Accept-Language`, else `default`), `default` is `en`. `User` and `AdminUser`
  gain `locale` (always sent, not in `required`). The new `ProblemCode` schema enumerates every
  problem `code` the server raises; `Problem.code` stays `type: string`, so clients keep tolerating
  an unknown code. `title` and `detail` become English and are informative only: clients localize
  by `code` ([i18n.md](../code/i18n.md)). Summaries and agent answers are generated in the owner's
  locale. All additive. Minor.
- **Chat over the base (2.7.0, `base-chat`):** `POST /base-chat` (202, with the question and up to
  10 history messages, which the client keeps) and `GET /base-chat/{chat_id}` (poll until `done` or
  `failed`), both with `summaries:read`. The state lives 1 h in Redis; another account's is 404;
  the account has at most 2 open questions (429 `rate_limited`). The answer carries `sources`, only
  the recordings the agent consulted. It is additive: no existing route changed. Since 2.14.0, the
  scope applies to the agent's **tools**, not to the route: a PAT without `transcripts:read` asks
  normally, but the agent only searches and reads summaries (without `search_transcripts` or
  `read_transcript`); a session and a device credential read both sources. Requiring
  `transcripts:read` on the route would be an extra scope on an existing route.
- **Public routes** (no credential): `GET /health` (static, sign of life), `GET /health/ready`
  (readiness since 2.13.0: 200 or 503 with only the name and `ok`/`down` of Postgres, Redis and
  storage), `GET /server` (descriptor: name, address,
  MCP address, root CA fingerprint and versions; since 2.21.0, `ca_next_sha256`, the fingerprint
  of the next root during rotation, optional and `null` outside it), `GET /privacy` (since 2.19.0:
  where each piece of data goes, `PrivacyInfo` with one `DataDestination` per purpose —
  transcription and the agent ones — in `server`, `local_network`, `external` or `disabled`, and
  who processes it only when it leaves; never the address, model, key or provider name; separate
  from `/server` because it changes at runtime and sign-up needs it before the acceptance), login
  and sign-up, admin login, `POST /devices/login` and `POST /devices/pair`. Those that check a
  credential (login, sign-up, admin login, `/devices/*` and, since 2.18.0, the two password reset
  routes, which add to the same key) have an attempt limit per IP and route: exceeded, **429**
  `rate_limited` with `Retry-After`. Since 2.14.0, the password logins (browser, device and admin,
  the latter with its own counters) also count the account's **failures**: per (account, IP) pair,
  10 in 15 min, and an account ceiling, 100 in 1 h, which does not block an IP that signed into it
  successfully in the last 30 days; success resets the pair. That way the attempts of an arbitrary
  IP do not lock the account's owner out. An invalid, expired or used pairing code is **401**
  `invalid_pairing_code`.
- **Password change** (`POST /me/password`): since 2.14.0, optional `revoke_tokens`; `true`
  revokes, besides the other sessions, the account's device credentials and PATs. Absent means
  `false`, the previous behaviour (the tokens remain). The web sends `true` by default.
- **Password reset by link** (since 2.18.0): the link `<url pública>/redefinir-senha#<segredo>`
  carries the secret in the fragment, which the page sends in the body of
  `POST /auth/password-reset/check` (200 `PasswordResetInfo`, the e-mail and the validity, without
  consuming it) and of `POST /auth/password-reset` (204; changes the password, consumes the link
  and ends every session of the account, without opening another; devices and PATs stay valid).
  Both are public (`security: []`). A nonexistent, expired or used link, or one of a deactivated
  account, is always **401** `invalid_reset_link`, the same answer so it does not serve as an
  oracle; a short password is **422** `validation_failed` without consuming the link.
- **User session only:** PAT management, the pairing code, the notice acceptance and the voice
  routes (tag `voice`: voiceprint, suggestion refusal and automatic assignment
  `/me/voice-assignment`, since 2.9.0; since 2.19.0 it carries `keep_samples`, `sample_count` and
  `voiceprint_people`, and `keep_samples: false` on the `PATCH` immediately deletes the account's
  samples, vectors and pending suggestions). A leaked PAT does not create another PAT and does not
  read nor delete biometric data. A PAT on one of these routes is **403** `session_required` since
  1.4.0 (before, 401): the credential is valid, it is just not the one accepted there. Without a
  credential, or a session without the CSRF, it stays 401.
- **Transcription language** (since 2.20.0): `GET /me/transcription` (session or PAT with
  `recordings:read`) returns the account's preferred language (`null` is the server default) and
  `platform_default`; the `PATCH` by session only. `language` on upload, on the recording's
  `PATCH` and on retranscribe accepts `auto` (an input loosening, additive); the resolution order
  is in [jobs-transcricao.md](jobs-transcricao.md).
- **Required speaker naming** (since 2.22.0): `GET /me/speaker-naming` (session or PAT with
  `recordings:read`) returns `required` and `waiting_count`; the `PATCH` by session only.
  `Recording.pipeline` went from six to seven steps (`speakers`, between transcription and type),
  with the new state `waiting` and the reasons `unnamed_speakers`, `continued_by_user` and
  `naming_not_required`: a new enum value and new item in a response, which clients already
  tolerate. `Recording.awaiting` (`speakers` or `null`), the filter
  `GET /recordings?awaiting=speakers` and `POST /recordings/{id}/continue` (`recordings:write`;
  409 outside the wait) complete it. Rules in
  [processamento-automatico.md](../code/processamento-automatico.md#speaker-naming).
- **Job failure** (`Job.error`): `code`, `message` and, since 1.4.0, `retryable` — a transient
  failure (lost worker, vanished or stalled job, lack of VRAM), which retranscribing or
  `POST /api/v1/admin/jobs/{job_id}/retry` tends to resolve.
- **Errors** in `application/problem+json` (RFC 9457) with the stable field `code`; the client
  decides by `code`, never by `title`. 404 does not distinguish "does not exist" from "is not
  visible". Since 2.14.0, any operation may answer **500** `internal_error` (the detail and the
  traceback stay only in the log, with the `X-Request-ID`).
- **Per-account quotas** (2.15.0): total storage, size per file, open uploads, audio minutes and
  agent requests in 24 h (rolling window); the effective quota is the account's override over the
  platform default, `null` is no limit. `GET /me/usage` (any credential, no scope) returns
  `{usage, quotas}`. Exceeded, **403** `quota_exceeded` with `quota`, `limit` and `used` — on a new
  `POST /uploads` (storage, size, open; deduplicating and resuming do not count) and on agent
  requests (generate summary, summary chat, base chat, previews). Audio minutes never refuse: the
  recording waits in the queue until the window opens. The account has at most 3 summaries queued
  or running; beyond that, **429** `rate_limited`.
- **Queue wait** (2.16.0): while the job is `queued`, `Job.queue` (`JobQueue`) says why the
  recording is waiting — `reason` in `processor_queue` (already in the processor's queue, with
  `ahead`, the jobs that start before, counting the running one), `account_turn` (held by the fair
  queue, with `account_ahead`, the account's own recordings before it) or `quota_window` (24 h
  minutes exhausted, with `resumes_at`) — and `processor` (`online`, `offline_since`).
  `estimated_start_at` is a forecast from the real duration of the latest transcriptions, `null`
  with no history or with the processor down, and every client labels it as an estimate. Outside
  `queued`, `queue` is `null`. Only counts and times: nothing of another account. `reason` is an
  open enum.
- **Body ceiling** (2.14.0): **413** `payload_too_large` on any operation with a body, with
  `limit` (bytes), refused by `Content-Length` before reading or counted as it arrives when the
  header is missing. Ceilings: 64 KiB on the public credential routes (`/auth/*`, `/admin/auth/*`,
  `/devices/*`), the part's bytes on the part `PUT` and 1 MiB on the rest of the API and on `/mcp`.
  The edge Caddy refuses above 9 MiB (without problem+json, because it only fires above the app's
  largest ceiling).
- **Pagination** by opaque cursor: `?cursor=&limit=` (1–200), response `{items, next_cursor}`,
  `next_cursor: null` on the last page. Incremental listing by `?since=` compares
  `updated_at >= since` (inclusive) and the client deduplicates by `id` + `revision`. Since 2.8.0, a
  summary that finishes or is edited also moves the `updated_at` of the recording and of the
  transcript, so `?since=` notices a new or redone summary. Since 2.17.0, the `summary` step that
  ends `failed` or `skipped` moves the `updated_at` **of the recording only** (the transcript's only
  moves with a new summary, so as not to wake the lumea importer), and the `?since=` of
  `GET /recordings` is how the desktop and the web read the end-of-processing notice
  (holetz/eclume#118). A cursor is valid
  only for the ordering (`sort`) that produced it.
- **Repeatable filters.** A listing filter declared as an array (`?tag=a&tag=b`) combines the
  repeated values with OR, and different filters combine with AND: `?tag=a&tag=b&kind=note` is a
  note with tag `a` or `b`. A time range is `from` (inclusive) and `to` (exclusive) over
  `recorded_at`, as in search.
- **Export** by `GET /recordings/{id}/export?format=`: `txt` (`text/plain`, a header and one
  line `[HH:MM:SS] Nome: texto` per segment), `srt` (`application/x-subrip`, one subtitle per
  segment), `md` (`text/markdown`, title, date and the current summary; without a summary, 409
  `summary_missing`) and `docx` (Word, with the summary and the transcript). The file name comes in
  `Content-Disposition`, as a slug of the title. `GET /transcripts/{id}/export?format=md` stays as
  the transcript export with frontmatter, which lumea reads.
- **Optimistic concurrency.** A write over a state the client read carries the version read
  (`base_version` in the summary edit); if the state changed, the answer is 409 with its own `code`
  (`summary_changed`) and nothing is overwritten.
- **Upload**, resumable in parts (S3 multipart orchestrated by the API): `POST /uploads` with the
  file's `sha256` → parts by `PUT` to opaque URLs that expire → `POST /uploads/{id}/complete`.
  The same hash as one of the user's recordings answers 200 `deduplicated` without transferring
  anything. Resuming is `GET /uploads/{id}` plus `POST /uploads/{id}/part-urls`. Since 2.14.0, a
  `complete` while another one of the same upload is in progress answers **409**
  `upload_completing` with `Retry-After`: it is transient, the client tries again (the desktop on
  the next cycle; the web, on resending, falls into hash deduplication). The browser uploads the
  already converted audio
  ([formato-audio-upload.md](../code/formato-audio-upload.md)): `audio/ogg; codecs=opus` and the
  `sha256` in lowercase hex that the conversion library returns.
- **Audio origin** (`source`): `desktop` and `mobile` are the recording apps, `upload` is the web
  import and `api` is the PAT. Without `recorded_at_source`, an upload with `recorded_at` coming from
  `desktop` or `mobile` gets `capture` (the clock of the app that recorded); from another origin,
  `user`; without `recorded_at`, `upload`.
- **Transcript** in the schema of `contracts/transcript.schema.json`: segments
  `{id, speaker_id, start_ms, end_ms, text}` (words only with `?include=words`), speakers
  `{id, label, person, suggestions}`, the audio's `content_hash` and `revision`, which goes up with
  each edit. A voice suggestion is never identity until someone confirms it: accepting is the
  speaker's `PATCH` with `person_id`, refusing is the `DELETE` of the suggestion
  ([identificacao-por-voz.md](../code/identificacao-por-voz.md)).

## Browsable reference

- **Every server serves the reference of the contract it implements** at `/referencia-api.html`:
  the web's `npm run build` runs `web/scripts/referencia-api.mjs` after `vite build`, which
  generates with Redoc (`@redocly/cli build-docs`, telemetry off, template
  `web/scripts/referencia-api.hbs`) an HTML from `contracts/openapi-v1.bundled.yaml`. The bundle
  enters the web image's context ([monorepo.md](../code/monorepo.md)), and the web's Caddy serves
  the file like any other in `dist`.
- **Nothing from outside the origin.** The template loads no external fonts (system fonts, DS
  colors); the Redoc script that `build-docs` points at the CDN becomes the local copy of the
  `redoc` package (exact version in `package.json`, checked by the `integrity` that `build-docs`
  writes), and the page state moves from the inline `<script>` to `dist/referencia-api/estado.js`.
  The build fails if the HTML still loads a resource from another origin (`src`, `srcset`,
  `<link href>`, `url()`, `@import`); navigation links in the examples do not count. The CSP of
  that path is the web's with `style-src 'unsafe-inline'`, because Redoc injects the CSS in
  `<style>` ([frontend-web.md](../code/frontend-web.md)).
- **The server does not serve `/docs` nor `/redoc`** (`docs_url=None`, `redoc_url=None` in
  `create_app`). The schema FastAPI derives from the routes is not the contract (it diverges in
  examples, descriptions, scopes and `/mcp`), and its UIs fetch JS and fonts from a CDN. The
  reference is always the bundle's, at the version the server runs.
- **What leads to the reference:** the Access tokens screen, the help article `criar-token`, the
  guide [integrar-com-a-api.md](../../how-to/integrar-com-a-api.md) and `contracts/README.md`.

## Evolution: v1 only grows

- **Allowed:** a new route; a new optional request field or parameter; a new response field; a new
  enum value in a response; a new error `code`; a new export format.
- **Forbidden:** removing or renaming; changing a type or meaning; making required what was
  optional; tightening existing input validation; requiring an extra scope or role on an existing
  route; changing the success status.
- **Clients tolerate the unknown:** they ignore new properties and new enum values in responses.
  That is why no response schema closes `additionalProperties`.
- **Every change** bumps `info.version` (and `schema_version` if it touches the transcript),
  updates the fixtures, regenerates the bundle and passes `uv run pytest contracts/tests`, which CI
  runs in the `contracts` job together with the mock smoke test.
- **Its own line.** `info.version` does not follow the product version nor the apps' versions
  ([versionamento.md](../code/versionamento.md)): each entry of the product's `CHANGELOG.md` cites
  the contract version it carries, and the versions of the compatible apps.
- **A break** becomes `/api/v2` in its own `openapi-v2.yaml`; v1 stays served during the
  transition, announcing the end with `Deprecation` and `Sunset`.
- **An obsolete field within v1 is an annotation, not a removal.** The property gains
  `deprecated: true` (OpenAPI 3.1 and JSON Schema 2020-12) and a description that says what it is
  worth today and where it leaves; it stays in `required` and filled, and the minor goes up as in
  every change. `contracts/tests` pins the list (`DEPRECATED_V1`) and fails if an obsolete field
  leaves `required` or loses the mark. Clients do not read an obsolete field in new code (the web's
  `schema.gen.ts` marks them `@deprecated`).
- **What `/api/v2` removes** (obsolete since 2.11.0 and transcript schema 1.2,
  holetz/eclume#100): `Recording.owner`, `TranscriptSummary.owner`, `Transcript.owner`,
  `VoiceSample.created_by`, `Summary.created_by` and `SummaryChatMessage.created_by` — leftovers of
  the model with an organization; with each account isolated, they are always the user themself.
  The chat over the base (`/base-chat`, obsolete since 2.23.0), which the Agent replaces, also
  leaves.
- **The redesign exception: the 2.x line under `/api/v1`.** The end of the organization (2.0.0,
  holetz/eclume#32) removed groups, sharing, invitations, per-person voice consent and the voice
  audit, and took `organization`, `groups`, `role`, `visibility` and `scope` out of the responses.
  The following redesign specs (holetz/eclume#33 to #41) still break routes that only this
  repository's own web uses (2.1.0 removes the summary templates and the summary block of the
  settings; 2.2.0 makes `agenda_type`, `provider` and `model` of `Summary` nullable, which gains
  hand-edited versions, and replaces the filters of `GET /recordings` with repeatable lists,
  compatible with a single value; 2.3.0 requires `recordings:delete` on `DELETE /recordings/{id}`,
  with the migration granting the scope to every token that had `recordings:write`, and blocks the
  session without the notice acceptance). The two clients outside the repository (desktop and
  lumea) only use uploads, recordings, transcripts and `/me`, which stay compatible; keeping the
  old v1 in parallel would require two RLS setups. That is why the 2.x line evolves under the same
  prefix until the redesign ends, and the contract tests require 2.x. After it, 2.x freezes, and
  the **next** break goes to `/api/v2`, with no other exception.

## Why

The contract exists before the backend so that the server, the frontend, the desktop and the
lumea importer develop in parallel against the same mock. That only works if nobody has to track
contract changes: hence the additive rule and the mandatory client tolerance. The upload is S3
multipart and not tus because MinIO already speaks the protocol, the API stays out of the bytes'
path and the Rust client and the browser only need HTTP `PUT`.
