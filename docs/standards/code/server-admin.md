---
type: standard
title: Admin panel in the server — admin account, settings, secrets, users and health
description: How the server serves the administration panel — the admin account and session separate from the user accounts, the platform's runtime settings (platform_settings with preprocessing, automatic language and the identification ⇒ diarization rule; per-field merge, validation and delivery to the worker through the transcribe options), the default agenda types, write-only encrypted secrets (platform_secrets; the HF token goes encrypted to the GPU worker), users with activate, deactivate and the password reset link, health with the queues, the GPU worker, the pipeline steps and the service probes, and the admin account CLI.
resource: server/src/eclume_server/settings_admin.py, server/src/eclume_server/health.py, server/src/eclume_server/accounts.py, server/src/eclume_server/cli.py, server/src/eclume_server/routes/admin*.py, server/src/eclume_server/db/migrations/008_conta_por_usuario.sql, server/src/eclume_server/db/migrations/027_redefinicao_de_senha.sql, worker-gpu/src/eclume_worker/health.py, worker-gpu/src/eclume_worker/secrets.py
tags: [code, server, admin, configuracao, segredos, usuarios, saude, cli]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#12, holetz/eclume#26, holetz/eclume#29, holetz/eclume#32, holetz/eclume#33, holetz/eclume#95, holetz/eclume#93, holetz/eclume#98, holetz/eclume#119, holetz/eclume#121
maintainer: holetz
---

# Admin panel in the server — admin account, settings, secrets, users and health

The admin panel belongs to the **platform**, not to a user: the admin account is separate from the
user accounts and sees and changes only what belongs to the platform. The agent providers (`/admin/agent-providers`)
are in [server-agentes.md](server-agentes.md); the agreement with the GPU worker, in
[jobs-transcricao.md](../api/jobs-transcricao.md).

On the **Admin → Agentes** screen, each provider's secret carries the label of its type: `claude-cli`
("Claude Code do servidor") asks for **"Token do Claude"**, with the explanation of how to get it
(`claude setup-token` on a computer logged into the subscription, a 1-year `sk-ant-oat01-…` token); the
others ask for "Chave de API". Both go in the same encrypted field `api_key`, and the server picks the
`claude -p` variable by the prefix ([server-agentes.md](server-agentes.md)).

## Admin account and session

- **`admins`** (`id`, `email` unique by `lower(email)`, `name`, `password_hash`, `active`,
  `created_at`, `last_login_at`) and **`admin_sessions`** (SHA-256 of the token, CSRF, `admin_id` with
  `CASCADE`, `expires_at`) have no RLS and no `GRANT` to `eclume_app`, like `sessions`. The same
  e-mail may exist in `users` and in `admins`: they are distinct accounts, with their own passwords and sessions.
- **Login** `POST /admin/auth/login` (public): argon2id, `last_login_at` and rehash as in the user
  login; sets `eclume_admin_session` (HttpOnly, Secure, SameSite=Strict,
  `Path=/api/v1/admin`, `ECLUME_ADMIN_SESSION_TTL_HOURS`, default 12 h) and `eclume_admin_csrf`
  (readable, `Path=/`). `POST /admin/auth/logout` deletes the session; `GET /admin/me` returns the account.
- **Boundary:** every `/admin/*` route depends on `auth.require_admin`, which accepts only the admin
  cookie, with double-submit `X-CSRF-Token` = `eclume_admin_csrf` on a mutating method. PAT, user
  session or nothing → 401 `unauthorized`. A deactivated admin neither enters nor keeps the session. The common
  credential rules are in [server-nucleo.md](server-nucleo.md#authentication).
- **The admin routes run in `system_tx`** (connection role) and only touch `platform_*`,
  `agent_providers`, `admins`, `admin_sessions`, `users` (list, recording count per owner and
  `active`), `sessions` and `api_tokens` (on deactivation), `password_resets` (generate and expire the link), plus the queue and the jobs for Health and
  retry. **No admin route returns user content:** title, transcript or person.

## Admin account CLI

- `eclume-server admin create --email --name [--password-stdin]` applies the migrations and creates an
  admin account; an existing e-mail or a password with fewer than 12 characters exit with code 2.
- `eclume-server admin set-password --email [--password-stdin]` changes the password and ends the
  admin's sessions; a nonexistent admin exits with code 2.
- Creating an admin and changing the password have no route in the panel. The user is born through sign-up
  ([server-nucleo.md](server-nucleo.md)); the tests use `accounts.create_user`.

## Runtime settings (`/admin/settings`)

- **Single source:** `platform_settings`, **one row** (`id boolean PRIMARY KEY DEFAULT true
  CHECK (id)`), with the blocks `asr`, `diarization`, `voice_identification` (`enabled`,
  `suggestion_threshold`), `preprocessing` and `quotas` (holetz/eclume#98, migration 026), plus
  `updated_at` and `updated_by` (FK to `admins`).
  The defaults live in migrations 008 and 011. The `summarization` block left in 011: the automatic
  summary follows the agenda type and the `summaries` provider
  ([automatic processing](processamento-automatico.md)).
  `eclume_app` reads the row (the voice on-off switch and the summary need it); only the admin writes.
- The `PATCH` merges **field by field** within each block (and, in `preprocessing`, within each
  step), writes `updated_at` and `updated_by` and
  returns the resulting settings, with `updated_by` pointing at the admin account (`{id, name}`).
- **Validation (422 `validation_failed`, field `bloco.campo`):** an unknown field is refused
  (including the ones that left, such as `summarization.default_template_id` and
  `voice_identification.consent_term_text`); `null` only where the schema accepts it; `compute_type` in
  `int8_float16`, `int8`, `int8_float32` or `float32` — `float16` is refused here, because the GTX
  16xx gives NaN with it ([worker-gpu.md](/docs/project/worker-gpu.md)); `diarization.model` only
  `pyannote/speaker-diarization-community-1`, the only pipeline the engine loads;
  `min_speakers ≤ max_speakers`; a JSON boolean in any numeric field (integer or float, in every block and
  preprocessing step) is a 422 instead of silently becoming `1`/`1.0` (`asr.batch_size`, `quotas.*`);
  `"4"` and `4.0` are still accepted; `endpoint_url` required with `engine: openai-compatible`;
  `voice_identification.enabled` requires `diarization.enabled` (the voiceprint is per speaker), checked
  only when the `PATCH` touches one of the two blocks: an old state that breaks it does not lock the editing of
  another block. Cross-field rules hold over the merged state, not only over what was sent.
- **Automatic language:** `asr.default_language: "auto"` sends `options.language = null`, and the
  engine detects the language of each recording.
- **The server default is the last resort:** `asr.default_language` only holds when neither the file
  nor the account chooses (`users.transcription_language` null); the full order (file → account →
  server → `pt`) is in [jobs-transcricao.md](../api/jobs-transcricao.md). `GET
  /me/transcription` returns the default in `platform_default` for the clients to name it
  ("Padrão do servidor: Português").
- **`preprocessing` block:** `denoise` (`enabled`, `method` `rnnoise`/`afftdn`, `strength` 0–1),
  `loudnorm` (`target_lufs` −30 to −10, `true_peak_db` −9 to 0, `lra` 1–20), `trim_silence`
  (`min_silence_s` 1–30, `threshold_db` −80 to −20) and `split_channels` (`enabled`). The conversion
  to 16 kHz mono has no key. It goes whole to the worker in `options.preprocess`; the order and the
  treatment are in the [jobs contract](../api/jobs-transcricao.md#preprocessing).
- **It holds for the next jobs.** The worker does not read the database: `transcribe_options` builds the
  `transcribe` `options` from `platform_settings` in a single place (`recordings.insert_job`),
  used by the completed upload, by retranscription and by retry. Finished transcripts do not change.
- **`voice_identification` block:** the platform's on-off switch and threshold. Turning it off deletes, in the
  same transaction as the `PATCH`, the `speaker_embeddings` and the pending suggestions of the whole
  platform, and then enqueues `purge_embedding_objects`. The rules are in
  [identificacao-por-voz.md](identificacao-por-voz.md).

## Default agenda types (`/admin/default-agenda-types`)

`default_agenda_types` belongs to the platform (no owner and no RLS; only the connection role and the admin
session): name, title pattern, how to identify, default tags, summary instructions, `position` and
`include_for_new_users`. The marked ones are copied to each account at sign-up
(`eclume_seed_user_defaults`); changing or deleting a default does not touch the copies the accounts already
have. A repeated name: 409 on `POST`, 422 on `name` in the `PATCH`.

## Secrets (`/admin/secrets`)

- `platform_secrets (name, value_encrypted, updated_at, updated_by)`, encrypted with
  `crypto.encrypt` (AES-256-GCM, [server-agentes.md](server-agentes.md)), with no `GRANT` at all to
  `eclume_app`. The API **never returns the value**: the listing brings each known name with `is_set` and
  `updated_at`. `PUT` writes or replaces (204), `DELETE` deletes (404 if there was none).
- **Fixed names, each with one reader:** `hf_token` (GPU worker) and `anthropic_api_key` (an
  `anthropic` provider without its own key, which wins when it exists). Another name → 422. A new secret comes in
  here together with the code that reads it. Whoever reads it to work (enqueueing, CPU worker) uses
  `settings_admin.secret_encrypted(conn, name)` with the connection role.
- **The HF token travels encrypted.** On enqueueing, the server adds `hf_token_encrypted` (the
  `v1:` text as it is in the database) to the payload's `options` — never to `transcription_jobs.options`. The
  worker opens it with the same key (`ECLUME_ENCRYPTION_KEY`, or the HKDF of `ECLUME_SECRET_KEY`), through
  a copy of the format in `eclume_worker/secrets.py`; the platform secret wins over `HF_TOKEN` and the
  mounted file. Failing to open does not fail the job: warning `hf_token_undecryptable` and the environment's token.

- **`quotas` block** (holetz/eclume#98): the default quotas of every account — `storage_bytes` (10 GiB),
  `file_bytes` (2 GiB), `open_uploads` (3), `gpu_minutes_24h` (600) and `agent_requests_24h` (200);
  `null` is no limit. Merged field by field by the same `PATCH /admin/settings`, with integers
  `>= 0` or `null`. The owner's account is not known to the migration: she overrides it through the panel
  after the deploy. Usage rules in [server-nucleo.md](server-nucleo.md#upload-and-audio) and
  [server-agentes.md](server-agentes.md#cota-de-pedidos-ao-agente).

## Users (`/admin/users`)

- The listing returns `AdminUser`: the account data (`User`, with `notice_version` and
  `notice_accepted_at`), `recording_count`, the usage (`usage`: storage, open uploads,
  audio minutes and agent requests in 24 h, `quotas.usage`) and the quota override
  (`quotas`, only the overridden fields, or `null`), from newest to oldest. Nothing of the
  content.
- `PATCH /admin/users/{id}` accepts `active` and `quotas` (at least one). Deactivating deletes the user's sessions and
  revokes their PATs and expires the pending reset link; reactivating gives access back through a new login. `quotas` replaces the
  whole override (`users.quotas`, JSONB): the fields sent hold over the default, `null`
  in a field is no limit and `quotas: null` returns the account to the default. Nonexistent user → 404.
- `DELETE /admin/users/{id}` deletes the account (204; nonexistent, 404) with `accounts.purge_user`, the
  same as deletion by the person themselves, without the password and with the connection role: the FKs cascade
  everything, the triggers put the objects in the bucket deletion queue, the open `transcribe` jobs
  receive the cancellation request and the e-mail is free for a new sign-up. The panel asks for
  confirmation by typing the e-mail.
- `POST /admin/users/{id}/password-reset` (201 `PasswordResetLink`) generates the password reset
  link with `accounts.create_password_reset`: a 32-byte secret in the fragment of
  `<url pública>/redefinir-senha#<segredo>`, with the URL from `server_info` (`ECLUME_PUBLIC_URL`, not
  the request's `Host`), valid for 24 h, and the `admin_id` of who generated it. Generating another expires the
  account's pending ones; deactivated account → 409 `conflict`; nonexistent → 404. The link only comes back in this response, and
  the panel shows it once for the admin to copy and hand over out of band, after confirming who is asking.
  The admin never sees or sets the password; the use of the link is in
  [server-nucleo.md](server-nucleo.md#authentication).

## Health (`/admin/health`)

- **GPU worker heartbeat:** the worker replaces `eclume:gpu:health` every 15 s (TTL 45 s) with
  version, engine, device, `busy`, the resident models (the ASR one and the step's) and, with NVML, GPU
  name, used and total VRAM and utilization; on SIGTERM, it deletes the hash. Hash missing = worker stopped
  for more than 45 s → `worker: null` and `gpu: null`. The fields are in the
  [jobs contract](../api/jobs-transcricao.md).
- **Queues:** per arq queue (`eclume:gpu`, `eclume:default`, `eclume:agents`), `running` = ids of the zset with
  `arq:in-progress:<id>`, `queued` = the rest. They are instance numbers, with no ids or content.
- **Held jobs (`held_jobs`, holetz/eclume#98):** numbers only — `account_turn`, the jobs that
  wait for the account's turn (it already has a `transcribe` on the GPU), and `gpu_minutes`, the ones that wait for the
  24-h minutes window (`dispatch.held_counts`). The
  [dispatch on the account's turn](../api/jobs-transcricao.md#queues) explains the holding.
- **Platform jobs and failures**, read with the connection role: `running_jobs` are the
  **dispatched** `queued`/`running` `transcription_jobs` (a held one counts in `held_jobs`, and that
  is why the `queued_over_2h` of `saude --json` does not alert on the wait for the turn) with step, progress and the `updated_at` of the
  progress hash; `recent_failures` are the last 20 `failed` pipeline steps in 24 h (all the
  steps), with `step`, and `job_id` and `retryable` only on preprocessing and transcription, which belong
  to the job the admin retries (the transient failure of the [dead job](../api/jobs-transcricao.md#dead-job),
  lack of VRAM, S3). The recording title never goes out: `recording_title` is always the fixed label
  "Gravação de usuário".
- **Steps (`steps`):** for each pipeline step except received, in the last 24 h, the
  completed runs (`done` and `failed`), the median `duration_ms` of the done ones and the failures, in a
  single `SELECT` of `pipeline_steps` with the connection role. Numbers only; the five steps always
  appear, zeroed when they did not run.
- **Services (`services`):** one probe per service, in parallel, with a ceiling of 2 s each —
  `healthy`, `degraded`, `down` or `absent`:

  | Service | Probe |
  |---|---|
  | `api` | the server version |
  | `postgres` | forced RLS (`relforcerowsecurity`) on all the user tables: detail "RLS ativa" |
  | `redis` | `PING` |
  | `storage` | `head_bucket`; above 1 s, `degraded` |
  | `gpu_worker` | the `eclume:gpu:health` heartbeat |
  | `cpu_worker` | the arq keys `eclume:default:health-check` and `eclume:agents:health-check` (the two CPU workers), renewed every 15 s (`health_check_interval`); with one missing, `down` with the detail `sem worker em <fila>` |
  | `mcp` | `absent` until holetz/eclume#35 |

  The bucket quota does not appear: the S3 API does not expose it.
- **Readiness (`GET /api/v1/health/ready`, public):** reuses the `postgres`, `redis` and
  `storage` probes above (`check_*` in `health.py`, 2-s ceiling, in parallel) and answers 200 with everything `ok`
  or 503 with the name of whoever went down (`down`), with no latency or error message, because it is public.
  `/api/v1/health` stays static (sign of life, `deploy.sh`, descriptor). The healthcheck of the
  `server` in the production compose is the readiness.
- **Worker probes without starting the worker:** `eclume-server sonda fila <default|agents>` exits 0 if the
  key `eclume:<fila>:health-check` exists; `python -m eclume_worker.health --sonda` does the same
  with `eclume:gpu:health`. They are the healthchecks of `worker` (both queues, through the light probe
  `python -m eclume_server.sonda fila default agents`) and `worker-gpu` (60 s, 3 attempts,
  `start_interval` of 2 s; `start_period` of 120 s on the GPU).
- **`eclume-server saude --json`:** the same `admin_health()` as the screen, plus a `summary`
  (`queued_over_2h`, `failed_last_24h`, `provider_auth_last_24h`, `services_down`) and the
  `claude_token` (`status` `ok`/`unknown`, `expires_at`, `days_left`). It is what the host's `vigia.sh`
  reads through `docker exec`, so that Health and the alert never disagree; the CLI log goes to stderr.
- **Claude token expiry:** `agent_providers.key_set_at` (migration 025) changes whenever the
  key changes (create, replace, delete). An `sk-ant-oat…` expires at `key_set_at + 365 dias`; keys
  older than the migration received the provider's creation date (the warning can only come early). A token
  only in the env's `ECLUME_CLAUDE_OAUTH_TOKEN` has no date: `unknown`.

## Retry (`POST /admin/jobs/{job_id}/retry`)

- Admin session only. It holds for the recording of any user — that is why it runs with the
  connection role —, but only for the recording's **most recent** job and in state `failed`: a nonexistent job
  is 404; an old or still open job is 409.
- The route **locks the recording row** (`recordings.lock_recording`, `SELECT … FOR UPDATE` in its
  own command) before reading the state, like the owner's retranscription: two simultaneous requests
  create a single revision, and the second gets 409 in problem+json, never 500.
- It creates the job of the next revision with the platform's current settings
  (`recordings.start_next_revision`, the same path as the owner's retranscription), sets the recording to
  `queued`, enqueues the `transcribe` with the encrypted HF token and answers 202 with
  `AdminJobRetried` (`job_id`, `recording_id`, `revision`, `state: queued`, `queued_at`).
- The web Health shows "Tentar de novo" on each recent failure, highlighted when `retryable`.

## Tests

`server/tests/test_admin_auth.py` (the admin session and the boundary with the user credentials),
`test_admin_settings.py`, `test_admin_secrets.py`, `test_admin_health.py` (with the retry) and
`test_cli.py` run with real Postgres, Redis and MinIO and strict conformance on; the
`admin` fixture opens the session of a new admin account and returns the platform to the defaults before and after
the test. The heartbeat is seeded in the test's Redis. The worker side is
`worker-gpu/tests/test_health.py` and the token tests in `test_jobs.py`.
