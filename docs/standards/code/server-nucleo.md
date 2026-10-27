---
type: standard
title: Server core — persistence, isolation, authentication, upload, people and search
description: How the eclume_server package stores and isolates data (SQL migrations by the migrator, the application connecting as eclume_server without superuser, a credential of its own per service in Redis and MinIO, per-owner RLS under the eclume_app role, platform tables outside RLS), authenticates (user session with CSRF and notice acceptance, personal or device PAT with scopes, attempt limit, separate admin session), receives uploads (part URL signed by the API itself, dedup and resume by hash, kind, date origin and markers), serves the library (time range and repeatable filters), organizes (people, collections and transcript editing, all of the owner), deletes in cascade, searches (eclume_pt full-text under RLS), runs lean (single worker with the default and agents queues in the same loop, light probe, lazy imports, pool and PAT with no write on every request) and is tested (real services, conformance with the bundled OpenAPI).
resource: server/**, engines/src/eclume_engines/registro.py, deploy/server.Dockerfile, deploy/docker-compose.test.yml, deploy/docker-compose.prod.yml
tags: [code, server, postgres, rls, auth, upload, pessoas, busca, admin, testes]
timestamp: 2026-10-26
audience: both
authority: current
source: holetz/eclume#5, holetz/eclume#12, holetz/eclume#15, holetz/eclume#26, holetz/eclume#32, holetz/eclume#34, holetz/eclume#35, holetz/eclume#37, holetz/eclume#86, holetz/eclume#97, holetz/eclume#100, holetz/eclume#92, holetz/eclume#94, holetz/eclume#93, holetz/eclume#99, holetz/eclume#98, holetz/eclume#119, holetz/eclume#150
maintainer: holetz
---

# Server core — persistence, isolation, authentication, upload, people and search

The `eclume_server` package (`server/`) implements [contract v1](../api/contrato-v1.md) with
FastAPI, SQLAlchemy 2 async (asyncpg), arq/Redis and boto3 against MinIO. Queries are explicit SQL
Core: isolation lives in the database policies, and the SQL that exercises them has to be
readable. The agreement with the GPU worker is in [jobs-transcricao.md](../api/jobs-transcricao.md);
summaries and agent providers, in [server-agentes.md](server-agentes.md); agenda types, fields and
processing steps, in [processamento-automatico.md](processamento-automatico.md); the admin
panel (admin account, settings, secrets, users and health), in [server-admin.md](server-admin.md).

## Configuration

Everything by environment (`eclume_server/config.py`):

| Variable | Default (dev) | What for |
|---|---|---|
| `ECLUME_DATABASE_URL` | `postgresql+asyncpg://eclume:eclume@127.0.0.1:5432/eclume` | connection role: `eclume_server` in production, the migrator (superuser) only in `migrate`; in dev, the superuser serves both |
| `ECLUME_RUNTIME_DB_PASSWORD` | — | when set, `eclume-server migrate` turns on the `LOGIN` of `eclume_server` with this password |
| `ECLUME_JOB_GRACE_SECONDS`, `ECLUME_JOB_STALL_SECONDS` | `120`, `1800` | dead-job detection ([jobs-transcricao.md](../api/jobs-transcricao.md#dead-job)) |
| `ECLUME_REDIS_URL` | `redis://127.0.0.1:6379/0` | arq queues and progress |
| `ECLUME_S3_ENDPOINT`, `_ACCESS_KEY`, `_SECRET_KEY`, `_BUCKET`, `_REGION` | MinIO of the dev compose | audio and artifacts |
| `ECLUME_SECRET_KEY` | insecure, dev | signs the part and audio URLs |
| `ECLUME_PUBLIC_URL` | the request's | absolute base of the URLs returned to the client |
| `ECLUME_COOKIE_SECURE` | `true` | `false` only in dev over plain HTTP |
| `ECLUME_SESSION_TTL_DAYS`, `ECLUME_ADMIN_SESSION_TTL_HOURS` | `14`, `12` | lifetime of the user session and of the admin session |
| `ECLUME_CREDENTIAL_ATTEMPTS_PER_MINUTE` | `10` | attempts per IP and route on the credential routes ([Authentication](#authentication)) |
| `ECLUME_LOGIN_FAILURES_PER_PAIR`, `ECLUME_LOGIN_FAILURES_PER_ACCOUNT` | `10`, `100` | login failures per (account, IP) pair in 15 min and per account in 1 h ([Authentication](#authentication)) |
| `ECLUME_UPLOAD_PART_SIZE` | `8388608` | upload part size and ceiling of the part `PUT` body; above 9 MiB, also raise the `request_body` of the edge Caddy |
| `ECLUME_SIGNUP_OPEN` | `true` | open sign-up; `false` closes `POST /auth/signup` (403 `signup_closed`) without a code deploy |
| `ECLUME_SIGNUPS_PER_IP_PER_DAY` | `5` | sign-ups created per IP in 24 h (sliding window); the next one gets 429 `rate_limited` |
| `ECLUME_ENCRYPTION_KEY` | derived from `ECLUME_SECRET_KEY` | encryption of the API keys ([server-agentes.md](server-agentes.md)) |
| `ECLUME_CLAUDE_BIN` | `claude` | CLI of the `claude-cli` provider |
| `ECLUME_DB_POOL_SIZE`, `ECLUME_DB_MAX_OVERFLOW` | `5`/`5` in the API, `3`/`2` in the worker | fixed and overflow connections of the process pool (`db.session.make_runtime_engine`); `pool_pre_ping` stays |
| `ECLUME_AGENT_MAX_JOBS` | `4` | slots of the `eclume:agents` queue in the worker |

## Logs

- **Format:** API, CLI, `worker` and GPU worker write one JSON line per
  record (`eclume_engines/registro.py`, `configurar_logs()`), with `ts` (RFC 3339 UTC), `level`,
  `logger`, `msg`, `exc` when there is an exception and, when set, `request_id`, `recording_id`,
  `revision` and `job_id`. It applies to `eclume_server.*`, `eclume_worker.*`, `eclume_engines.*`,
  `uvicorn.*` and `arq.*`. API and workers write to stdout (`docker compose logs`); the CLI to
  stderr, because its stdout is data (`saude --json`, `discover`).
- **Context through `ContextVar`, not through arguments:** the `RequestIdMiddleware` middleware sets
  `request_id`; the `on_job_start` of the arq workers and the GPU worker's `transcribe` set `job_id`,
  `recording_id` and `revision`, read from the `_job_id` `{job}:{recording_id}:{revision}`.
- **`X-Request-ID`:** every HTTP response of the API carries it — the one received, if it has up to
  128 characters of `[A-Za-z0-9._-]`, or a new one (uuid4 hex) — and the request's log lines carry
  the same value.
- **Access log:** `eclume_server.acesso` records method, path, status and duration.
  `uvicorn.access` stays silent. `/api/v1/health` and `/api/v1/health/*` only enter when the response
  is 4xx or 5xx: the healthcheck and the panel hit them all the time.
- **arq cron:** the INFO of the `cron:*` runs of `arq.worker` does not go to the log (they run every
  minute or less); failure, retry and every WARNING pass (`registro.SemCronDoArq`).
- **Unexpected 500:** the generic handler of `problems.py` answers `problem+json` with
  `code: internal_error`, without detail, and records the exception with its traceback in
  `eclume_server.problems` (level `ERROR`), with the response's `request_id`.
- **Body ceiling:** `limits.BodyLimitMiddleware`, plain ASGI, picks the ceiling by path (64 KiB
  on the credentials, `ECLUME_UPLOAD_PART_SIZE` on the part `PUT`, 1 MiB on the rest and on `/mcp`),
  refuses by `Content-Length` without reading and counts the bytes of `receive` when the header is
  missing; past the ceiling, it discards what the app would answer and returns 413 `payload_too_large`.
- **Never in the log:** query string (the part and audio URLs are signed), credential
  headers, e-mail, title, transcript or summary text, tokens and keys.

## Processes, queues and probe

The cost of each process of the server image is that of importing what it uses; that is why the
image has few processes and each one imports only its own (holetz/eclume#150).

- **Single worker.** `eclume-server worker` (`worker.run_combined`) runs **two** `arq.Worker` in the
  same event loop: the one for `eclume:default` (`WorkerSettings`: ingestion, return failures, embedding
  purge and the crons) and the one for `eclume:agents` (`AgentWorkerSettings`: the per-agent jobs, no
  crons). Each queue keeps its own slots (`max_jobs`; `ECLUME_AGENT_MAX_JOBS` on the agents one),
  functions, `poll_delay` (2 s on the default, 1 s on the agents one) and health-check key
  (`eclume:<fila>:health-check`); the database engine and the storage client are one. The
  workers are created with `handle_signals=False` and the process registers SIGTERM and SIGINT once,
  forwarding them to both; the process exits when both finish, and if one falls with an exception the
  other is stopped. `WorkerSettings` and `AgentWorkerSettings` still hold for standalone `arq` (staging,
  e2e, tests); the default queue **no longer** runs the agent jobs (the transition of
  holetz/eclume#96 is over).
- **Light probe.** `python -m eclume_server.sonda fila <default|agents>...` imports only the standard
  library and `redis.asyncio` (reads `ECLUME_REDIS_URL`), and exits 0 if **all** the named queues have the
  health-check key (16 s), 1 if any is missing and 2 on wrong usage; in the single worker, one call
  with both queues is enough. `eclume-server sonda fila <nome>...` remains, and delegates to it.
- **Lazy imports.** `cli.py` imports the modules inside each branch of `main()`;
  `eclume_server.contract` holds `CONTRACT_VERSION` with no dependencies (`routes/auth.py`,
  `server_info.py` and `discovery.py` read from it); the agent providers (`anthropic`, `openai`…) are
  only imported when `build_provider` uses them; `docx` only when building or reading a `.docx`;
  FastAPI only loads where there is a route, response or handler (`pagination.Limit`/`Cursor` and the
  responses of `problems.py` import it on demand). Tests (`test_sonda.py`) check, in a subprocess,
  that the probe does not import `anthropic`, `fastapi` or `sqlalchemy` and that `eclume_server.worker` does not
  import `anthropic`, `docx` or `fastapi`: whoever adds an import at the top of those modules
  breaks the test.
- **Image.** `deploy/server.Dockerfile` pins `MALLOC_ARENA_MAX=2` (fewer glibc arenas in
  threaded processes) and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (the `claude` CLI does no
  telemetry, update or other traffic beyond what is needed).

## Persistence

- **Migrations in versioned SQL**, `eclume_server/db/migrations/NNN_nome.sql`, applied in order
  by `eclume-server migrate` (table `schema_migrations`, `pg_advisory_lock`). A schema change
  is a new file; a file applied in any environment never changes again. There is no Alembic:
  RLS, roles and `GRANT` are DDL that autogenerate does not express.
- `eclume_server/db/tables.py` describes the tables in SQLAlchemy Core **only to type** the
  queries (jsonb, arrays, uuid); it never creates anything.
- A new migration takes the next free number **on `main`**, not on the branch: two specs in
  parallel do not fight over the same `NNN`. The runner applies every migration not yet applied, so the
  order of arrival between branches does not matter.
- **Index of open jobs** (migration 033): `transcription_jobs (state) WHERE state IN
  ('queued','running')`, so the queue and the sweeps do not read the history. The migrator runs each
  file in a transaction, so a new index is `CREATE INDEX IF NOT EXISTS` without `CONCURRENTLY`.
- **Expand or contract, never both.** Every migration is one of the two (holetz/eclume#92):
  *expand* only adds (table, nullable or defaulted column, index, new function) and lands
  together with the code that uses it; *contract* (remove, rename, tighten a constraint) only lands in a
  deploy **after** the one of the code that stopped depending on the object. So the code of the previous
  deploy runs on the new schema: `migrate` with old server and workers up is safe and
  a one-step `deploy.sh --voltar` needs no database restore. There is no `down`: beyond one step, the
  path is the pre-deploy dump (`restaurar-backup.sh --banco`).
- `eclume-server migrate --pendentes` lists the migrations the tree knows and the database has not
  applied, one per line, without applying anything (`migrate.pending`).

## Database roles

Three roles, each with a reason:

| Role | Attributes | Who uses it | What for |
|---|---|---|---|
| migrator (the image's `eclume` superuser) | superuser, owner of every object | only the one-shot `migrate` (and `admin create`, the backup) | DDL, extensions, roles, `GRANT` |
| `eclume_server` | `LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE`, owner of nothing, member of `eclume_app` | server and CPU worker | `SELECT/INSERT/UPDATE/DELETE` on every table, `USAGE` on the sequences, `EXECUTE` on the functions; read-only on `schema_migrations` |
| `eclume_app` | `NOLOGIN NOBYPASSRLS` | every request transaction, through `SET LOCAL ROLE` | the RLS policies |

- Migration `006_papel_de_conexao.sql` creates `eclume_server` (`NOLOGIN`, idempotent) with the
  migrator's `GRANT`s and `ALTER DEFAULT PRIVILEGES`, so that the following migrations are born
  accessible. The password does not live in SQL: `eclume-server migrate` with `ECLUME_RUNTIME_DB_PASSWORD`
  turns on the `LOGIN` and sets the password (`ALTER ROLE ... PASSWORD` built by `format(%L)`).
- The `BYPASSRLS` of `eclume_server` is deliberate: the system operations (resolving a credential,
  ingestion, summaries, admin panel, upload expiry, signed media) cross accounts by
  design. What the role loses is the owner's power — DDL, `ALTER`, `DROP`, roles — and the
  superuser's. Also removing `BYPASSRLS` would require each `system_tx` as a `SECURITY
  DEFINER` function.
- `migrate` only creates `schema_migrations` when it is missing (`to_regclass`): with the schema up to date,
  `admin create` also runs under `eclume_server`, which has no `CREATE` on the schema. For the tests,
  `migrate(engine, until="NNN_nome")` stops at a version, and the test of the next migration seeds the
  database in the format of the previous one.
- The server suite applies the migrations as superuser and runs entirely as `eclume_server`
  (`harness.provision`); a test checks the role's attributes, that it owns nothing and that
  `CREATE TABLE` and writing to `schema_migrations` are denied.

## Redis and MinIO credentials

In production, each service uses its own credential (holetz/eclume#94), as in the database; the code does not
change, because the Redis DSN and the S3 keys come from the env (`ECLUME_REDIS_URL`, `ECLUME_S3_*` in the server,
`ECLUME_S3_ENDPOINT_URL` in the GPU worker).

| Credential | Who uses it | Reach |
|---|---|---|
| MinIO root (`ECLUME_MINIO_USER`) | MinIO, the one-shot `minio-init` and the host backup scripts | everything; never in an application service |
| MinIO `eclume-server` (policy `eclume-app`) | server, CPU worker and agent worker | `s3:*` on the `eclume` bucket |
| MinIO `eclume-gpu` (policy `eclume-fila-gpu`) | GPU worker | `GetObject` on `eclume/users/*/recordings/*/audio` and `PutObject` on `eclume/recordings/*`; does not list or delete |
| Redis `default` | nobody | disabled (`user default off`) |
| Redis `eclume-server` | server, CPU and agent workers | all keys, all commands except `@dangerous` (`INFO`, which arq reads at startup, comes back) |
| Redis `eclume-gpu` | GPU worker | only `arq:*`, `eclume:gpu*`, `eclume:default`, `eclume:progress:*` and, read-only, `eclume:cancel:*`; no `@dangerous`, `@admin` or pub/sub |

- The Redis ACL is a `configs.content` interpolated from the production compose (the
  Caddyfile pattern). `minio-init` (root) creates the bucket, the users and the policies on every deploy,
  idempotently: `user add` on an existing user only swaps the password for the env's, and the policy is
  recreated on top, without deleting the user.
- The passwords (`ECLUME_MINIO_SERVER_PASSWORD`, `ECLUME_MINIO_GPU_PASSWORD`,
  `ECLUME_REDIS_SERVER_PASSWORD`, `ECLUME_REDIS_GPU_PASSWORD`) are hex, because they go into the URL;
  `deploy.sh` generates the missing ones.
- The dev, test, e2e and GPU composes stay without a Redis password and with the MinIO root.
- `deploy/test_compose_prod.py` fails if the root credential shows up in an application service, if a
  service changes credential or if the `eclume-gpu` ACL gains a key.

## RLS isolation

- **Each account owns what is its own.** Every content table has `owner_id` (FK to `users`,
  `ON DELETE CASCADE`): `recordings`, `uploads`, `collections`, `agenda_types`, `fields`,
  `field_values`, `pipeline_steps`, `people`, `transcription_jobs`, `transcripts`, `speakers`, `segments`, `speaker_embeddings`, `summaries`,
  `voice_samples` and `speaker_suggestions`. On the derived ones, `owner_id` is denormalized from the
  recording on write (ingestion and the creation of a job and a summary copy it).
- **The only context is `app.user_id`** (`eclume_user()`). Every policy is a
  `LEAKPROOF` equality on the row itself: `<tabela>_own` with `USING` and `WITH CHECK`
  `owner_id = eclume_user()`; `users_self` with `id = eclume_user()`; `api_tokens_own` with
  `user_id = eclume_user()`; `pairing_codes_own` likewise. No policy queries another table, so there is no
  anti-recursion rule to maintain. What each table allows sits in the `GRANT`s of `eclume_app`.
- **Every user request transaction** runs `SET LOCAL ROLE eclume_app` (a `NOLOGIN` role,
  without `BYPASSRLS`) and sets `app.user_id` with `set_config(..., true)` —
  `db.session.user_tx(engine, user_id)`. Without context, `eclume_app` sees nothing.
- **Platform tables stay outside RLS** and outside the write reach of `eclume_app`:
  `platform_settings` (one row; `eclume_app` only reads, for the voice on-off switch and the summary),
  `platform_secrets`, `admins`, `admin_sessions` and `sessions` (no `GRANT` at all), and
  `agent_providers` (no RLS; `eclume_app` reads only the secret-free columns, with a column-by-column
  `GRANT SELECT`, and the encrypted key is left to the connection role).
- **System operations** — credential lookup, admin panel, CPU worker — run with the
  connection role (`system_tx`), which needs `BYPASSRLS` (`eclume_server`), because `FORCE` subjects even
  the owner to the policies.
- The API answers **404** for what is not the user's: there is no reader other than the owner, so
  there is no "sees but does not write" 403.
- **Link to a person only within the same account:** `people` has `UNIQUE (id, owner_id)`, and the FKs of
  `speakers`, `voice_samples` and `speaker_suggestions` are on `(person_id, owner_id)`.
- **A non-`LEAKPROOF` operator does not reach the index under RLS.** The planner first applies the
  policy's quals and only takes to an index the user qual that is `LEAKPROOF`: equality of `uuid` and
  `text` qualifies, `@@` (tsvector) and array `@>`/`ANY` do not. When the index matters, a
  `SECURITY DEFINER` function (with `SET search_path = public, pg_temp`) uses the index restricted to
  `eclume_user()` and returns **only keys**; the `eclume_app` query joins those keys to the table, and
  the policy still decides what the user sees. That is the case of `eclume_segment_matches`.
- **A side effect in the database** that the row itself does not carry (renaming a person bumps the
  `updated_at` of the transcripts in which they speak) lives in a trigger, never in a `system_tx` inside the
  route.

## Authentication

Two distinct accounts, with credentials that do not cross: the **user account** (`users`), with
session and PAT, and the **admin account** (`admins`), with its own session. The same e-mail may exist
in both.

- **Password** with argon2id in both accounts, **off the event loop and outside a transaction**:
  `security.hash_password_async`/`verify_password_async` run argon2 in a thread with a
  semaphore of 4 per event loop (`PASSWORD_THREADS`: each hash uses 64 MiB, and the default pool would open
  room for 2.5 GiB in a burst). Login reads the account in one transaction, checks the password outside it and
  writes in another; the hash of a new password (`accounts.new_password_hash`) is computed before
  opening the transaction. **User session:** a random token in the cookie
  `eclume_session` (HttpOnly, Secure, SameSite=Lax, 14 days) and a readable `eclume_csrf`; the database
  stores the token's SHA-256 and the CSRF (`sessions`). A mutating method with a session requires `X-CSRF-Token`
  equal to the session's CSRF.
- **PAT** `eclp_` + 40 base62 characters, stored as SHA-256 (a high-entropy secret
  needs no slow hash); `prefix` = the first 9 characters. `last_used_at` (and
  `mcp_last_used_at`, on use through MCP) is only rewritten when the stored value is more than 60 s old
  (`auth.USED_AT_RESOLUTION`): a request with a PAT does not write to the database on every call. A present `Authorization: Bearer`
  never falls back to the cookie.
- **Token kind** (`api_tokens.kind`, migration 015): `personal`, the PAT of `POST /tokens`
  (always of this kind), or `device`, the credential of a device (`platform` filled), which is only
  born from `POST /devices/login` or `POST /devices/pair`
  ([server-mcp-e-dispositivos.md](server-mcp-e-dispositivos.md)). Both authenticate the same way, through the
  same `Bearer eclp_`; `GET /tokens?kind=` separates the lists and `DELETE /tokens/{id}` revokes
  either. Use by the MCP server writes `mcp_last_used_at` along with `last_used_at`.
- **Scopes:** `ALL_SCOPES` in `auth.py`. Recording deletion has its own scope,
  `recordings:delete` (015 granted it to every token that had `recordings:write`, which used to
  delete).
- **Notice acceptance on the session:** the session of an account that has not accepted the notice in force gets
  **403** `notice_required` on every route, except those marked `requires(before_notice=True)`
  (`GET /me`, `POST /me/notice`, logout); the public `/auth/*` routes ask for no credential. The
  PAT is not blocked (see [Sign-up and notice](#sign-up-and-notice)).
- **Attempt limit** (`ratelimit.py`): a fixed 1-minute window in Redis
  (`INCR` + `EXPIRE` on `eclume:rl:<rota>:<ip>`), 10 attempts per IP on `/auth/login`,
  `/auth/signup`, `/admin/auth/login`, `/devices/login`, `/devices/pair` and the two routes of the
  password reset (`auth_password_reset`, one key to check and to reset), and the code exchange has
  a global ceiling (see [server-mcp-e-dispositivos](server-mcp-e-dispositivos.md)). When exceeded,
  **429** `rate_limited` with `Retry-After` (seconds until the window reopens). The IP is uvicorn's
  with `--proxy-headers`, which trusts Caddy's `X-Forwarded-For`.
- **Login failures per account** (`check_login`, `login_failed`, `login_succeeded`), with scope
  `user` (browser and device add up) or `admin`: before checking the password, 429 if the pair
  `eclume:rl:{escopo}_fail:{email}:{ip}` reached `ECLUME_LOGIN_FAILURES_PER_PAIR` failures (15-min
  window) or if the account `eclume:rl:{escopo}_fail:{email}` reached
  `ECLUME_LOGIN_FAILURES_PER_ACCOUNT` (1-h window) and the IP is not in
  `eclume:rl:{escopo}_known:{email}` (sorted set of the IPs with a correct login in the last 30 days).
  A failure adds to both counters; a success zeroes the pair and records the IP as known. Counting only
  failures, and sparing the known IP, keeps the attempts of an arbitrary IP from locking out the account's
  owner, without opening uncapped distributed brute force.
- **Password reset link** (`password_resets`, migration 027; only the connection role reads it,
  like `sessions`): the admin generates (see [server-admin.md](server-admin.md)) a 32-byte secret
  (`security.new_session_token`) stored only as SHA-256, valid for 24 h (`RESET_TTL`), which goes in the
  fragment of `/redefinir-senha#<segredo>` and never in the query or the path: it does not reach the proxy,
  the access log or the `Referer`. Generating another one and deactivating the account expire the pending ones
  (`accounts.expire_password_resets`). `accounts.password_reset_info` checks without consuming;
  `accounts.reset_password` computes the new password's hash first (a short password does not touch the link) and,
  in one transaction, consumes the link with an atomic `UPDATE … WHERE token_hash AND used_at IS NULL AND
  expires_at > now() AND conta ativa RETURNING`, swaps the password and deletes **all** the
  account's sessions, without opening another; devices and PATs remain valid (`revoke_tokens=False`, like
  the change without the option). A nonexistent, expired, used or inactive-account link gives the same **401**
  `invalid_reset_link`.
- **Admin session:** `POST /admin/auth/login` opens `eclume_admin_session` (HttpOnly, Secure,
  SameSite=Strict, `Path=/api/v1/admin`, `ECLUME_ADMIN_SESSION_TTL_HOURS`) and a readable `eclume_admin_csrf`
  (`Path=/`), stored in `admin_sessions`. `auth.require_admin` is the dependency of every
  admin route: it accepts **only** that cookie, and a present `Authorization`, a user cookie or nothing
  give 401. Outside `/admin/*`, the admin cookie is ignored (`auth.requires` does not even read it). The
  user's `Principal` has no role: no user credential has admin power.
- **Error statuses, aligned with what each operation declares:**
  - no credential, invalid credential, missing or wrong CSRF, or a user credential on
    `/admin/*` → **401** `unauthorized`: a session without double-submit is incomplete, and the web
    answers 401 with a new login, which recovers the cookie;
  - PAT on a session-only route (PATs, pairing code, voice, logout) → **403**
    `session_required` (contract 1.4.0): the credential is valid, it just is not the one accepted there;
  - session of an account without acceptance of the notice in force → **403** `notice_required` (2.3.0);
  - missing scope → **403** `insufficient_scope` with `required_scopes`;
  - a request outside the contract (parameter, body or business rule) → **422**
    `validation_failed` with `errors[]`, on any operation, like the mock;
- Deactivating a user (`PATCH /admin/users/{id}`) deletes their sessions and revokes their PATs.

## Sign-up and notice

- **Open sign-up**, with no invitation and no e-mail confirmation: `POST /auth/signup` (public) with
  name, e-mail, password (12+) and `notice_version`. The account is born with acceptance of the notice in force
  ("Sou responsável por pedir o consentimento das pessoas que gravo" — "I am responsible for asking the
  consent of the people I record"), the default agenda types
  marked for new accounts and the built-in fields, title and tags (`accounts.create_user`, which
  calls `eclume_seed_user_defaults`), and the session open,
  with the login cookies. `GET /auth/signup` says whether sign-up is open and returns the notice.
- **Ceilings:** besides the attempts per minute and per IP (`attempts`), at most
  `ECLUME_SIGNUPS_PER_IP_PER_DAY` (default 5) sign-ups **created** per IP in a sliding
  24-h window (`ratelimit.check_signups`, zset `eclume:rl:signup_day:{ip}`); the next one gets 429
  `rate_limited` with `Retry-After` until the oldest leaves the window. A refused sign-up (422, 409,
  403) does not count (holetz/eclume#98).
- **Errors:** sign-up closed (`ECLUME_SIGNUP_OPEN=false`) → 403 `signup_closed`; e-mail already
  registered (case-insensitive, including in the race, through the unique index) → 409 `email_taken`;
  notice missing or not the version in force, short password, invalid e-mail or name → 422.
- **The notice has a version** (`accounts.NOTICE_VERSION`, `NOTICE_TEXT`). `users.notice_version` and
  `notice_accepted_at` are both null (migrated account, still without acceptance) or both filled
  (`CHECK`). `GET /me` returns `notice_required` when the account has not accepted the version in force, and
  `POST /me/notice` (session only) records the acceptance. A new notice text is a new version: the
  accounts see `notice_required` again.
- **Pending acceptance blocks only the session** (2.3.0): the web does not go past `/me` and the acceptance while
  it is missing, and the server also guarantees this for whoever calls the API with the cookie. The PAT is not
  blocked: the desktop and lumea use PATs of migrated accounts, and the web is the one that asks for acceptance.
- The test factories (`make_user()`) create the account **with** the acceptance;
  `make_user(notice_version=None)` is the migrated account, without it.

## The account by its own user

Only through the session (the PAT does not serve) and with the credentials' attempt limit (`attempts`):

- **Change the password:** `POST /me/password` with `current_password`, `new_password` and
  optional `revoke_tokens` (`accounts.confirm_password` and `accounts.change_password`). Wrong current
  password → 422 on `current_password`; a new one with fewer than 12 characters → 422 on `new_password`.
  It writes the new hash and deletes the account's other sessions; the current one continues. With
  `revoke_tokens: true`, it writes `revoked_at` on all the account's `api_tokens` (device
  credentials and PATs), like the admin's deactivate; without it, the tokens continue. The web sends `true` by
  default: whoever changes the password on suspicion of a leak expects the leaked access to end (it reverses the
  decision of #86 to keep the PATs).
- **Delete the account:** `POST /me/delete` with `password` (`accounts.confirm_password`, then
  `accounts.purge_user`, the same one `DELETE /admin/users/{id}` uses without the password). Wrong password →
  422 on `password`, and nothing changes. It deletes the user, and the FKs cascade everything that is theirs;
  after the commit, the route deletes the objects of each recording in storage
  (`storage.delete_recording`) and answers 204 with the session cookies deleted, like logout.

## Upload and audio

- **Per-account quotas** (holetz/eclume#98, `quotas.py`): the effective quota is `users.quotas` (only the
  fields overridden by the admin) over `platform_settings.quotas`, field by field; `null` is no
  limit. The `POST /uploads` that would open a **new** upload checks, before creating the multipart, the
  file size (`file_bytes`), the open uploads (`open_uploads`, unexpired `in_progress`,
  counting the new one) and the storage (`storage_bytes` = `recordings.size_bytes` + the
  open uploads + the new one; transcript artifacts are left out); when exceeded, **403**
  `quota_exceeded` with `quota`, `limit` and `used`. Dedup and resume do not go through the quota. The
  audio minutes (`gpu_minutes_24h`) never refuse: the sum of `recordings.duration_ms` of the jobs
  dispatched in the last 24 h decides the [dispatch](../api/jobs-transcricao.md#queues), and the
  recording waits, held. `GET /me/usage` returns `{usage, quotas}` to any credential.

- **The part URL is the API's own `PUT /api/v1/uploads/{id}/parts/{n}`**, signed like an
  S3 presigned one (`?expires=&sig=`, HMAC-SHA256 of `ECLUME_SECRET_KEY`, 1 h, never beyond the
  upload). The URL authorizes itself: the browser does not echo CSRF and the desktop sends no credential.
  The API writes the part to MinIO (`UploadPart`). Chosen over Caddy → MinIO with `Host`
  preserved because it keeps a single origin, with no CORS and without exposing MinIO; the real volume (Opus at
  ~15 MB/h) fits in the API. The URL is opaque to the client: switching to a presigned one later breaks
  nobody.
- Parts of `ECLUME_UPLOAD_PART_SIZE` (8 MiB; the last one smaller), at most 10 000; a `Content-Length`
  other than the expected one → 409. The body is read in chunks (`request.stream()`) and going past the
  part size is 413 `payload_too_large` without reading the rest. `parts_received` comes from `ListParts`. The first 100 URLs come at creation; the rest through
  `part-urls`. An upload is valid for 7 days; the CPU worker aborts the expired ones every 30 min. The MinIO of every
  compose keeps the incomplete multipart for `MINIO_API_STALE_UPLOADS_EXPIRY=192h` (8 days, above
  the 7), so resume holds until the end.
- **A vanished multipart is never a 500.** `Storage` translates `NoSuchUpload` into `MultipartGoneError`:
  `GET /uploads/{id}` marks the upload `expired` and answers with it; resume by hash marks the
  old one `expired` and opens another; the part `PUT` and `complete` mark `expired` and answer 409
  `upload_expired`. On `complete`, a vanished multipart with the object present (`head_object`) is the
  earlier `complete` whose commit failed: it goes on to the hash and the recording without reassembling. The desktop and
  the phone (`eclume-sync`) restart the upload once on receiving that 409.
- **Dedup and resume by hash:** the same `sha256` as one of the user's recordings → 200 `deduplicated`;
  as one of their `in_progress` uploads → the same upload, with URLs for the missing parts.
- **`complete`** closes the multipart, rereads the object in streaming to check the SHA-256 and creates
  recording and job, in three steps and **with no S3 inside a transaction**: (1) a short transaction reads and checks
  the upload; (2) outside a transaction, under the lock `eclume:upload:completing:{id}` (`SET NX`, TTL of
  2 min renewed every 30 s while S3 works), it assembles the multipart and computes the hash; (3)
  a short transaction with `FOR UPDATE` creates recording and job and marks `completed`; deleting the duplicate
  object comes after the commit. Another `complete` with the lock held → 409 `upload_completing` with
  `Retry-After`; the lock of a dead process expires and the next `complete` resumes (step 2 is
  idempotent through the already assembled object). Chosen over a `completing` state in the database, which
  would need a migration and a new value that desktop and phone would have to tolerate. A diverging hash → recording `failed` with `job.error.code = hash_mismatch`, and the
  recording stores the **real** hash, leaving the declared one free for a new upload. A repeated `complete`
  returns the same recording.
- **Keys:** audio at `users/{dono}/recordings/{gravação}/audio`; worker artifacts at
  `recordings/{gravação}/…`, as the jobs contract fixes. `recordings.audio_key` stores the whole
  key and is always the source. Recordings from before per-user accounts were at
  `orgs/{org}/users/{dono}/…`; `eclume-server storage relocate-legacy [--dry-run]` moves them once
  (idempotent): it copies to the new key (skips the copy if the destination already has the same size),
  swaps `audio_key` and puts the old one in the deletion queue in the same transaction, skipping a recording with a
  `queued`/`running` job (the queued `transcribe` carries the old key).
- **Obsolete fields** `owner`/`created_by` (contract 2.11.0): no join with `users`; the name is that of the
  transaction's user (`serialize.requester_name`), the only one RLS lets through.
- `GET /recordings/{id}/audio` redirects (302) to `/media/recordings/{id}/audio?expires=&sig=`,
  served by the API with `Range` from MinIO — outside `/api/v1`, opaque to the client.

## Recording: date, kind and markers

- **`recorded_at` is the start of the recording**, and the end of the calendar event is
  `recorded_at + duration_ms`. There is no `started_at`: the desktop already sent the capture start in
  `recorded_at`, required in `Recording`, `Transcript` and `SearchHit`, and renaming would break three
  clients for no gain.
- **`recorded_at_source`** says where the date came from: `capture` (clock of the app that recorded),
  `file_metadata` (read from the file in the browser, before the conversion to Opus, and confirmed on
  import), `user` (typed or corrected) or `upload` (no date; the send time holds). Without it
  on the upload, the server decides: with `recorded_at` and `source: desktop`, `capture`; with `recorded_at`
  and another origin, `user`; without `recorded_at`, `upload` (another origin without a date → 422). Correcting
  `recorded_at` in the `PATCH` sets the origin to `user`. Migration 014 marked `capture` on the
  desktop recordings and `upload` on the rest: the earlier web import sent no date.
- **`kind`**: `meeting` (default) or `note` (voice note), on the upload and in the `PATCH`. The note goes
  through the same pipeline as the meeting (type detection and summary included);
  [processamento-automatico.md](processamento-automatico.md) does not tell the two apart. In transcription, the note
  carries `min_speakers = max_speakers = 1` in the job (a single person), without the admin's global limits;
  `POST .../retranscribe` may ask for another pair (`min_speakers`/`max_speakers`), which holds only for the
  new revision and overrides the note rule.
- **Type chosen on upload** (`agenda_type_id`, the "Agenda type" sheet when stopping the recording on the
  phone): it becomes the user's type, origin `edited`, with the title pattern and the default tags
  applied already on `complete`; detection respects it (`set_by_user`). Nonexistent type → 422.
- **Markers** (`markers`): an instant `at_ms` with an optional note (up to 500 characters) and the
  `device_name` of who marked it, linked to the recording by a composite FK with the owner. Idempotent through
  `UNIQUE (recording_id, client_id)`: the `client_id` is generated by the app, and resending the same marker
  only updates the note (`ON CONFLICT DO UPDATE`; in the same batch, the last one wins); a resend without a note
  keeps the existing one, edited on the web. They arrive in two
  ways: in `UploadCreate.markers` (up to 1 000, written on `complete` with the capture's `device_name`
  and, on a deduplicated upload — at creation or on `complete` —, merged into the existing
  recording, because the app may have crashed after uploading the audio), or later through
  `POST /recordings/{id}/markers` (batch, `device_name` from the body). `PATCH /markers/{id}` changes the
  note and `DELETE` deletes; `GET` lists in `at_ms` order on a single page. An `at_ms` beyond the duration
  is accepted: the duration is only known after transcription. `Recording.marker_count` is a
  lateral subquery of `recording_select`. Scopes `recordings:read`/`recordings:write`.

## Library

- `GET /recordings` is the library of the week, the month and the list: `from` (inclusive) and `to`
  (exclusive) over `recorded_at`, with the index `recordings_owner_recorded_idx (owner_id,
  recorded_at, id)`, and `sort` `created_desc` (default), `recorded_asc` or `recorded_desc`. The cursor
  is the position `(chave do sort, id)` (sort key, id): it holds only for the `sort` that generated it. The week and the month ask for
  `limit=200` and follow the cursor.
- **Repeatable filters:** OR between values of the same filter, AND between different filters.
  `kind`, `status` (`processing` is `queued` with the worker reporting progress, refined after
  the query), `tag` (`tags && :tags`), `collection` (`collection_ids && :ids`), `person`
  (`EXISTS` on a transcript speaker linked to one of the people) and `field=<field_id>:<valor>`. In
  `field`, each field is a filter: values of the same field by OR, different fields by AND; text
  and choice compare the value, list accepts one of the items (`value @> [valor]`), and title and tags, which
  are built in, compare `recordings.title` and `recordings.tags`. A field the account does not have
  finds nothing; `field` without `:` → 422.

## Deletion

- `DELETE /recordings/{id}` deletes the recording row and leaves the rest to the cascading FKs:
  transcript, segments, speakers, embeddings, voice samples, summary versions, adjustment
  chat, markers, field values and pipeline steps. A job still in the queue (`summarize`,
  `summary_chat`, the per-agent steps, `ingest_transcript`) finds the row deleted and ends
  with no effect.
- **Deletion queue on the bucket** (`storage_deletions`, migration 024, no RLS and no GRANT to
  `eclume_app`). `AFTER DELETE` `SECURITY DEFINER` triggers enqueue, in the same transaction as the
  `DELETE` (and the cascade): from `recordings`, the `audio_key` and the prefix `recordings/{id}/`; from
  `in_progress` `uploads`, the multipart abort. So the route, the MCP tool and account
  deletion cover everything without touching S3 after the commit. Ingestion enqueues the
  revision's `speaker_embeddings.json` in its own transaction (biometrics only in the database).
- **Drain** (`drain_storage_deletions`, minute cron, `unique`, worker of `eclume:default`): up to
  100 due rows with `FOR UPDATE SKIP LOCKED`; deletes the key, lists and deletes the prefix, aborts
  the multipart (`NoSuchUpload` = done) and removes the row. A failure adds to `attempts`, stores `last_error`
  and postpones (1 min doubling up to 1 h). It never gives up: a stuck row is the signal for observability.
- **Reconciliation** (`reconcile_storage`, Sunday 04:00, `unique`): enqueues every object of
  `users/`, `orgs/` and `recordings/` older than 24 h whose key is the `audio_key` of no
  recording (or whose `recordings/{id}/` has no recording), and every multipart older than 24 h with no
  `in_progress` upload with that `s3_upload_id`. The margin covers a `complete` not yet committed.
- **Minimum retention** (`purge_expired`, daily): user and admin sessions expired for more than
  1 day and terminal uploads (`completed`, `deduplicated`, `aborted`, `expired`) older than 30
  days. An app that resumes after that gets 404, opens another upload and falls into dedup by hash.
  `api_tokens` stay: the user sees the revoked ones.

- **Audio retention** (`audio_retention.py`, cron `purge_audio` daily at 03:50, `unique`). Each
  account sets `users.audio_retention_days` (1 to 3650; `NULL` is off, the default) through
  `GET`/`PATCH /me/audio-retention`; the admin sets one ceiling, `platform_settings.retention.
  audio_max_days` (`NULL` is none). The window in force is `min(user, ceiling)` when both exist,
  the user value without a ceiling, and none when the user value is `NULL`: the ceiling only caps
  user values and never deletes anything for an account that left retention off. A value above
  the ceiling is stored as typed and capped on read, so raising the ceiling needs no action from
  the user. The age is `recordings.created_at` (when the server received the audio), never
  `recorded_at`, which the user controls.
- **The purge** selects due recordings under the system role and, per recording, in one short
  transaction under a row lock re-checks the predicate (so a job that appeared meanwhile is
  honoured), sets `audio_key = NULL` and `audio_deleted_at = now()` together (a CHECK keeps the
  two in agreement) and inserts the key into `storage_deletions`; the existing drain removes the
  object and retries until the bucket lets go. A recording with a `queued` or `running` job is
  skipped until the next run. Only the audio object goes: the derived artefacts under
  `recordings/{id}/`, the transcript, summary, chat, markers and voiceprints stay.
- **A recording without audio** is the single state `audio_deleted_at IS NOT NULL`, exposed as
  `Recording.audio_deleted_at`. Both audio routes (`GET /recordings/{id}/audio` and the signed
  media URL) answer `410` with code `audio_deleted`; `start_next_revision` refuses with `409`
  `audio_deleted`, which covers retranscribe and the retry of a failed job; the voice
  identification adds no sample from it (see identificacao-por-voz.md). Every reader of
  `audio_key` treats `NULL` as gone.

## People, collections and transcript editing

- **People belong to the user** (`people`, owner policy), with `people:read`/`people:write` on the
  PAT. E-mail unique among the user's people (`(owner_id, lower(email))`): 409 on creation, 422
  on `email` in the `PATCH` (which does not declare 409). `sort_name = lower(eclume_unaccent(name))` orders the
  directory and serves `q` by prefix of the name, of any word of the name or of the e-mail; cursor
  `(sort_name, id)`. `eclume_unaccent` is `unaccent` with a fixed dictionary, `IMMUTABLE`, so it fits
  in a generated column.
- **Speaker ↔ person** through the composite FK `speakers (person_id, owner_id) → people (id, owner_id)` with
  `ON DELETE SET NULL (person_id)`: a link to a person of another account is impossible in the database, and
  deleting the person only unlinks the speakers (the `label` stays). `transcript_count` and `last_seen_at`
  count the user's transcripts. Renaming or deleting the person bumps the `updated_at` (not the
  `revision`) of every transcript in which they speak, through the trigger `eclume_touch_person_transcripts`.
- **Voice:** the person stores no consent; acceptance of the notice at sign-up replaces it. Samples,
  comparison, suggestions and forgetting the voice are in
  [identificacao-por-voz.md](identificacao-por-voz.md).
- **Transcript editing** — speaker `PATCH` (`label`, `person_id`), `POST .../speakers/merge`
  and segment `PATCH` — with `transcripts:write`. Every edit bumps `revision` and `updated_at`.
  Linking without a `label` uses the person's name; a nonexistent person or one of another account → 422 on
  `person_id`. Merging deletes the source speakers and their voiceprints and recomputes
  `talk_ms`; correcting the text discards `words` and reindexes the `tsv` (generated column).
- **Collections belong to the user** (`collections`, owner policy). `recordings.collection_ids`
  stays an array: the API only accepts ids of the user's own collections (422 on `collection_ids`, in
  `PATCH /recordings` and in `POST /uploads`, which applies them on `complete`), deduplicates, and deleting the
  collection removes it from the recordings (`array_remove`), bumping their `updated_at`. `recording_count`
  counts the user's recordings. `GET /tags` aggregates `unnest(tags)` of the user's recordings.

## Full-text search

- Config `eclume_pt`: a copy of `portuguese` with `unaccent` before `portuguese_stem`, so
  "liderancas" finds "lideranças". `segments.tsv` is a generated column `to_tsvector('eclume_pt', text)`
  with a GIN index.
- `GET /search` runs under RLS. With `q`: `websearch_to_tsquery('eclume_pt', q)` (quoted phrase,
  `-exclusão`), joined with `eclume_segment_matches(tsquery)` to use the GIN, ordered by `ts_rank_cd`
  desc, then `recorded_at` desc and the position of the utterance. With only `person`: the person's utterances in
  chronological order, `rank` 0. Neither `q` nor `person` → 422. Filters `person`, `from`/`to` (`recorded_at`),
  `tag`, `collection` and `field` combine with either mode.
- `field=<field_id>:<valor>` (repeatable) has the library's semantics: OR within the same field, AND between
  fields, list by item, title and tags like the built-in ones. The predicate is a single one,
  `fields.field_filters`, over `recordings`, used by `GET /recordings` and by `GET /search`; the
  field is read under RLS, so the `field_id` of another account finds nothing.
- `highlight` = `ts_headline` with `HighlightAll` and sentinel markers (`\x02`/`\x03`, removed
  from the text beforehand); Python escapes the text and only then swaps the markers for `<mark>`/`</mark>`.
  No other HTML reaches the client.
- Cursor = opaque offset (`encode_position`): ranking in `real` gives no stable keyset.
- Measured (240 thousand segments, the host's pg16): a rare term 14 ms through the function against 956 ms for a direct `@@`
  under RLS; a common term (24 thousand passages) 217 ms against 457 ms.

## Tests

- Real Postgres, Redis and MinIO, from `deploy/docker-compose.test.yml` (project `eclume-test`,
  ports `127.0.0.1:55532/56479/59100`, data in `tmpfs`). Each test session creates a migrated
  database, a bucket and clears a Redis database. Without the services, the server tests **skip**;
  with `ECLUME_TEST_REQUIRE_SERVICES=1` (CI), their absence **fails**.
- **Conformance:** a response hook on the `TestClient` validates every `/api/v1` response against
  `contracts/openapi-v1.bundled.yaml` with the objects closed (`strictify`): declared status,
  required headers and body. A test checks that the implemented routes are exactly the contract's operations.
- **Isolation** is proven through the API and through direct SQL under `eclume_app` between two accounts, on every
  content table (`test_isolation.py`); search has its own: it never returns a segment of another
  account, not even through the GIN function (`test_search.py`).
- **The platform is a single one in the test session's database.** A test that changes settings,
  secrets or providers uses the `platform` fixture (`admin` already uses it), which returns the platform
  to the migration defaults before and after. `make_user()` creates the account with the seeded agenda types and fields;
  `admin` opens the session of a new admin account.
- **A migration that transforms data** has a test on the previous format: `test_migration_008.py`
  applies up to 007, seeds the database as 007 stored it and checks what 008 preserves and removes.
- `eclume_server_testing.fakes.transcribed(api, settings, **campos)` uploads an audio and runs both
  workers: it returns the recording already with the 3-speaker transcript of the contract fixture.
- Running in parallel with another suite on the same host, bring up the compose with its own project and ports
  (`ECLUME_TEST_PG_PORT`, `ECLUME_TEST_REDIS_PORT`, `ECLUME_TEST_MINIO_PORT`) and point
  `ECLUME_TEST_DATABASE_URL`, `ECLUME_TEST_REDIS_URL` and `ECLUME_TEST_S3_ENDPOINT` at them.
- The transcription cycle runs with the fake GPU worker (`eclume_server_testing/fakes.py`) and the real CPU
  worker. An `arq.Worker` keeps the current loop when it is born: create it inside the loop that runs it.

```bash
docker compose -p eclume-test -f deploy/docker-compose.test.yml up -d --wait
ECLUME_TEST_REQUIRE_SERVICES=1 uv run pytest server/tests
uv run eclume-server migrate
uv run eclume-server admin create --email admin@exemplo.com.br --name "Admin" --password-stdin
uv run uvicorn eclume_server.app:create_app --factory
uv run eclume-server worker
uv run arq eclume_server.worker.WorkerSettings
uv run arq eclume_server.worker.AgentWorkerSettings
```
