---
type: standard
title: Meeting detection and sync in the desktop app
description: The desktop app notices a meeting from the mic in use by another process combined with process and window title, applies the app's policy (record, ask or ignore) with debounce and a visible indication, signs in to the server with e-mail and password or a pairing code (first run, mDNS and the CA pinned by fingerprint) and uploads each recording with the device credential through contract v1's resumable upload (with the chosen transcription language), only deleting the local file after confirmation, and announces the end of processing of each of the account's recordings (summary ready with "Copiar", summary that failed, ready with no summary, transcription that failed) and keeps the account's latest recordings in the window's Recentes panel (phase, progress, "precisa de você" and Copy summary) and in the tray menu's Recentes section, each with its own count — these are the signals, the state machine, the account, the protocol, the outcome notice, the recent panel, the CA and retention, and what the sync crate offers the mobile app.
resource: desktop/crates/detect/**, desktop/crates/sync/**, desktop/src-tauri/src/auto.rs, desktop/src-tauri/src/sync.rs, desktop/src-tauri/src/recent.rs, desktop/src-tauri/src/account.rs, desktop/src-tauri/src/notify.rs, desktop/src-tauri/src/config.rs, desktop/src-tauri/src/tray.rs, desktop/ui/**
tags: [code, desktop, deteccao, sync, upload, dispositivo, mdns, tls, tauri]
timestamp: 2026-10-06
audience: both
authority: current
source: holetz/eclume#13, holetz/eclume#28, holetz/eclume#40, holetz/eclume#41, holetz/eclume#57, holetz/eclume#117, holetz/eclume#118, holetz/eclume#121, holetz/eclume#102, holetz/eclume#101, holetz/eclume#141, holetz/eclume#144, holetz/eclume#147, holetz/eclume#153
maintainer: holetz
---

# Meeting detection and sync in the desktop app

Two crates, each with the pure part kept apart from the part that touches the OS: `eclume-detect`
(`desktop/crates/detect`) and `eclume-sync` (`desktop/crates/sync`). The app
(`desktop/src-tauri`) only wires the two to the state, the tray and the window. The recording
itself, the queue and the `Uploader`/`MeetingDetector` traits are in
[desktop-gravacao.md](desktop-gravacao.md).

## Detection

```
SignalSource::snapshot() ─▶ classify() ─▶ Debouncer ─▶ MeetingEvent ─▶ AutoRecorder ─▶ Action
  (OS, every 1 s)          Option<AppKey>  3 s / 15 s   Started/Ended    policies        Start/Stop/Ask/Dismiss
```

**Signals** (`Snapshot { mic_users, mic_busy, processes, window_titles }`, `platform/`):

| OS | Who uses the mic | Window titles |
|---|---|---|
| Linux | Pulse source-outputs (or PipeWire's through the Pulse layer) that are not corked and do not read a monitor | not read (Wayland does not allow it) |
| Windows | `HKCU\…\CapabilityAccessManager\ConsentStore\microphone`, packaged apps and `NonPackaged`, with `LastUsedTimeStop = 0` | `EnumWindows`, only when a browser uses the mic |
| macOS | Core Audio processes with active input (14+); before that, `DeviceIsRunningSomewhere` of the default device, with no owner, plus the process list | not read (requires Screen Recording) |

eclume itself leaves the list by pid and by executable name, otherwise the recording would detect
itself. The name comes only from the last component of the id (on Windows, the id is the whole
path): an app in a folder with "eclume" in the path stays visible to detection.
`cargo run -p eclume-detect --example sinais -- 10` prints the snapshots and the classification
for field diagnosis.

**Classification** (`AppKey`: `teams`, `zoom`, `meet`, `webex`, `slack`, `whatsapp`, `navegador`, `outro`):

1. Mic free → no meeting, with any app open.
2. Native meeting app using the mic (binary, name or bundle with `teams`, `zoom`, `webex`,
   `slack`, `whatsapp`...) → that app.
3. Browser using the mic → the window title decides (`meet.google.com`/`Meet - ` → `meet`,
   `Microsoft Teams` → `teams`, `Zoom Meeting` → `zoom`, `WhatsApp` → `whatsapp`, the last one
   checked last so it does not beat a meeting open in another tab); with no known title,
   `navegador`.
4. Mic busy with no identified owner → a meeting process running (Zoom's `CptHost`, Teams) or
   `outro`.
5. Any other mic user → `outro`.

The contract's `capture.meeting_app` receives `teams`, `meet` or `zoom`; the rest goes as `other`.

**Debounce**: the meeting starts after 3 s of continuous detection and ends after 15 s
continuously without it. One `Started` per meeting; a failure to read the signals counts neither
as presence nor as absence.

## Policies and automatic recording

`config.json` → `detection: { enabled, policies: { <app>: auto | ask | ignore } }`. Default:
`enabled: true`, `ask` for every app and `ignore` for `outro`. Recording someone without notice is
the user's decision, so `auto` is never a default.

| Event | State | Action |
|---|---|---|
| `Started` | idle, policy `auto` | starts an automatic recording |
| `Started` | idle, policy `ask` | asks (stays pending until an answer or the end) |
| `Started` | already recording, detection off or `ignore` | nothing |
| `Ended` | automatic recording | stops |
| `Ended` | pending question | removes the question |
| answer "Gravar" (Record) | idle | starts an automatic recording |
| answer "Ignorar" (Ignore), manual stop | — | holds until the end of that meeting |

- A manual recording is never stopped by detection, and starting one by hand removes the pending
  question.
- **Visible indication:** an automatic recording only starts with the tray up; the tray switches
  the icon and the line ("Gravando · Microsoft Teams (automático)") and a notification goes out.
- **The question** goes by native notification with the Gravar and Ignorar actions — `notify-rust`
  (D-Bus) on Linux, a toast with buttons (`tauri-winrt-notification`, the installed app's AUMID or
  PowerShell's in dev) on Windows, `mac-notification-sys` on macOS — and also stays in the tray
  menu and in the window, because the OS may suppress the notification.
- **Every notice on Windows** (the question, recording, meeting ended, note saved, updated, "A
  gravação parou") goes out through the toast with the installed app's AUMID, with eclume's name
  and icon; PowerShell's AUMID only applies in dev (`tauri::is_dev()`). `notify-rust` stays for
  Linux and macOS.
- **Action deadline on Linux:** a notification with actions (the question, the outcomes) waits at
  most 15 min; once the deadline passes with no answer, the app closes it and the waiting thread
  ends. The question and the summary remain in the tray, the window and the web.
- With detection off, the detector only follows to the end the meeting it had already seen.
- **Where it changes:** Settings · Meetings has the "Detectar reuniões" `.switch` and the 8 apps,
  each with the Gravar, Perguntar and Ignorar `.seg` and the DS subtitle, and "Restaurar padrões"
  returns to `DetectionConfig::default()`. During an automatic recording, the main screen shows
  the "Reuniões no <app>" `.seg`, which changes that app's policy right there.

## Sync

**Protocol** (`protocol.rs`), over contract v1 ([contrato-v1.md](../api/contrato-v1.md)):

1. `POST /api/v1/uploads` with `filename`, `content_type`, `size_bytes`, hex `sha256`,
   `recorded_at`, `recorded_at_source`, `kind`, `duration_ms`, `source`, `markers` (omitted when
   empty), `title` and `agenda_type_id` (both only when the row has them: the phone chooses them
   on stop), `language` (the queue row's, which the phone chooses on the "Gravação salva" sheet;
   without it, the device's chosen in the Audio tab — `auto`, `pt`, `es` or `en`, through
   `HttpUploader::with_language`; with neither, the key is left out and the account's language on
   the server applies; the Audio tab names that default with the real language, read from
   `GET /me/transcription` by the `account_language` command: "Padrão da conta: Português", and
   "Detectar automaticamente" only for `auto`) and
   `capture { meeting_app, device_name, client_version }`. Everything comes from the queue row
   ([desktop-gravacao.md](desktop-gravacao.md)):

| Recording | `filename` | `kind` | `source` | `recorded_at_source` | `content_type` |
|---|---|---|---|---|---|
| meeting | `2026-09-24 14-00 Teams.ogg` (local time) | `meeting` | `desktop` | `capture` | `audio/ogg; codecs=opus` |
| note | `2026-09-26 10-42 nota.ogg` | `note` | `desktop` | `capture` | `audio/ogg; codecs=opus` |
| import | `<nome original>.<extensão enviada>` | `meeting` | `upload` | `file_metadata` or `user` | Ogg/Opus, or the copied file's |

   Markers go with `client_id`, `at_ms` and the note; the `capture`'s `device_name` is the
   hostname, which the server copies to each marker. Markers stay editable until the upload is
   created (`upload_id` in the queue): resumption reuses the upload with the markers from when it
   was born, and from then on editing happens on the web.
2. `200 deduplicated` → confirmed with the existing `recording_id`, without transferring anything.
3. `201` → the `upload_id` goes to the queue before the first part; each missing part goes up by
   `PUT` to the received `url`, with its `headers`, and the `ETag` is kept. Missing URLs come from
   `part-urls` (up to 1000 per request).
4. `POST /uploads/{id}/complete` with the ETags → `201` with the recording: that is the
   confirmation.

- **Resumption:** with an `upload_id` kept, `GET /uploads/{id}` — `in_progress` uploads only what
  is missing in `parts_received`; `completed`/`deduplicated` confirms directly; `404`, `expired`
  or `aborted` recreate the upload. The `sha256` is computed once, in blocks, and kept.
- **Credential only on the same origin:** `Authorization` goes on the API's own part URLs and never
  on a presigned URL of another origin (S3 refuses two authentication mechanisms). A presigned
  URL refused with `403` is renewed through `part-urls` once.
- **Messages without secrets:** every error message of `transport.rs` and the retry warning of
  `protocol.rs` carry the URL through `redact` (scheme, host and path), without the query string:
  a presigned URL's carries the signature.
- **Per-request retry:** a network failure, `408`, `429` and `5xx` retry up to 3 times, with
  1 s, 2 s and 4 s or the `Retry-After` (ceiling of 60 s). `401`, `403`, `422` and the rest fail
  at once, with the problem's `code` and `detail` in the message.
- **Retry in the queue:** a failure schedules `next_attempt_at` (30 s doubling up to 1 h);
  "Sincronizar agora" and saving the settings return the failures to the queue at once.
- **"Sincronizando"** (Syncing) turns on through a guard (`AppState::syncing`) and goes back to
  normal even when the pass panics; the updater, which only runs when idle, is not held up by it.
- **Loop** (`src-tauri/src/sync.rs`): every 30 s, and when a recording stops, the settings
  change, the person signs in or asks, it runs `retry_due` → `sync_pending` with the
  `HttpUploader` → retention. With no credential, nothing goes up and the window says "Entre para
  enviar 2 gravações". After a failure with the pinned CA, the loop checks whether the server's CA
  changed (below).
- `ureq` 3 transport with rustls (ring): no `reqwest`, which would bring in `aws-lc-rs` by default.

## Processing-end notice

- After each turn of the loop, at most every 60 s, the app reads `GET /recordings?since=<since>`
  (`recordings:read`, which the device credential has) — the recordings **of the whole account**
  that changed, imported through the web, recorded on the phone or on it. The server moves
  `updated_at` when the `summary` step ends (`done` since 2.8.0, `failed`/`skipped` since 2.17.0,
  [contrato-v1.md](../api/contrato-v1.md)); the same read also wakes the synced folder.
- **One `?since=` read per minute, shared** (holetz/eclume#153, `sync::library_since`): the
  outcomes, the recent items (outside the fast pace) and the synced folder each ask for their own
  `since`, but the account's last read is kept for **55 s** (`SHARED_READ_TTL_MS`) and answers
  whoever asks for the same `since` or a newer one, filtering by `updated_at` (dates compared as
  dates). Whoever arrives without being covered reads from the server and leaves theirs, older,
  for the others. The read belongs to the account that made it: a change of address or of
  credential does not inherit the other's. Effect: the outcome notice can arrive up to ~1 min
  after the server, as before.
- **The outcome** (`eclume_sync::outcome::outcome_of`, mirrored in
  `web/src/app/processingWatch.ts` with the same test cases): `summary` step `done` is **summary
  ready**, `failed` is **summary failed**, `skipped` is **ready with no summary** (with the reason)
  — except `cancelled`, `summary_deleted` and `before_pipeline`, which do not notify —, recording
  `failed` with job `failed` is **transcription failed** (job `cancelled` does not notify) and,
  since 2.22.0, the `speakers` step in `waiting` is **needs you** ("Nomeie os locutores para seguir
  com o resumo", only "Abrir"). The instant is the step's or the job's `finished_at`; naming a
  speaker without clearing the gap does not move the wait's, so the notice does not repeat.
- **The watermark** (`Watermark`, in `resumos-avisados.json` in the data directory): the next
  `since` (largest `updated_at` minus 60 s), the mark (outcomes up to it do not notify; it
  advances to the largest instant seen minus 60 s) and the notified ones above it (id → instant,
  kept for 7 days). Each outcome is notified once: editing the title afterwards does not repeat
  it, and a redone summary is another instant. Without the file, or with the old format (id →
  instant in ms), the mark starts at "now": neither the first open nor the update fires old
  notices.
- With "Avisar quando uma gravação terminar de processar" on (`notify_summary`, the old key, on by
  default): "Resumo pronto · <título> · copie para compartilhar" with **Copiar** (the Markdown read
  from `GET /recordings/{id}/summary`, put on the clipboard by the
  `tauri-plugin-clipboard-manager`) and **Abrir**; "O resumo falhou", "Pronta sem resumo ·
  <motivo>" and "A transcrição falhou", only with **Abrir** (`<web_url>/gravacoes/<id>`). The title
  is the one the server gives the recording ("Gravação" if empty). More than three outcomes in one
  turn become a grouped notice ("N gravações processadas") that opens the library. The actions use
  the same path as the meeting question: D-Bus on Linux, a toast with buttons on Windows, and on
  macOS the main button and the close one (a notice with only Abrir has no close one).
- **The server title** of each item of the read goes to the queue (`Queue::set_server_title`,
  queue v5, [desktop-gravacao.md](desktop-gravacao.md)), and the upload queue shows the title
  given on stop, else the server's.
- **The wait in the queue** (holetz/eclume#117) does not come from `?since=`, because the position
  changes without moving `updated_at`: for recordings sent from here less than 24 h ago still with
  no outcome, `Client::queue_wait(id)` reads `job.queue` in `GET /recordings/{id}`, even with the
  notice off; the loop keeps the waits by remote id in `StatusView.queue_waits`, and the upload
  queue shows, under the row, the vocabulary's `fraseDaEspera` phrase (`.fila-espera`).

## Recent recordings panel

The top of the main screen shows the account's last N recordings (holetz/eclume#141), assembled
in Rust (`recent.rs`) and delivered by the `recent` command as `RecentView { count, items,
needs_you, fetched_at, error }`; the window only applies the vocabulary's labels
([desktop-interface.md](desktop-interface.md)).

- **How many.** Two separate counts (holetz/eclume#147): `Config.recent_count` for the window,
  from 0 to 10, **5 by default**, and `Config.tray_recent_count` for the tray menu, from 0 to 10,
  **1 by default** (both also in a config from an earlier version); `0` hides the panel or the
  section. They change in Settings → General → "Gravações recentes na janela" (Ocultar, 3, 5 or
  10) and "Gravações recentes no menu da bandeja" (Ocultar, 1, 3 or 5). The read asks for the
  **larger** of the two (`recent::fetch_count`) and each cuts the same list at its N; with both at
  0, it does not read.
- **From where.** First the local queue rows not yet on the server (recording, waiting for upload,
  uploading, upload failed), then the page `GET /recordings?limit=N&sort=
  created_desc` (`Client::recent`, **a single page**, without paging). One sent from here whose id
  is on the page is a single row, the server's, with the queue wait from
  `StatusView.queue_waits`. With no read yet, the sent ones appear as "Enviada". The total is cut
  at N.
- **When.** Its own thread, `eclume-recentes`, separate from the outcomes' `?since=`: every
  **5 s** with the window visible and some row in progress, every **60 s** otherwise, and at once
  when nudged (`recent::nudge`) — after an upload turn of the sync, on saving the settings and
  through the `recent_refresh` the main screen calls on open. With no credential, it does not
  read. A failure stays in `error` and the panel keeps the last snapshot.
- **Backoff and incremental read** (holetz/eclume#153). Failing reads double the wait starting
  from the normal pace (5 s: 10, 20, 40, 60; 60 s stays at 60 s), ceiling `ERROR_MAX_INTERVAL` of
  **60 s**, and the first that succeeds goes back to the normal pace. At the slow pace (window
  hidden or nothing in progress) the read is not the page: it is the shared `?since=` (above),
  with the `since` at the page's largest `updated_at` minus 120 s, and `recent::merge_changes`
  replaces by id, adds the new ones and cuts to the N most recent by creation. The **whole page**
  comes back at the fast pace, every `FULL_READ_EVERY_MS` (**10 min**), when the loop is nudged,
  on the first read and when the count changes — it is what removes a deleted recording from the
  list.
- **The phase** of each server row comes from the `status`, the `job` (`state`, `stage`,
  `progress`, `error.code`/`retryable`, which `JobInfo` reads with `serde(default)`; progress in
  thousandths) and the `pipeline`, in this precedence — alert, then in progress, then ready:

| Situation | `phase` | Alert (`attention`) and action |
|---|---|---|
| step `status` or `state` outside contract 2.20.0's enums | `unknown` | `needs_you` · Abrir no web |
| job `cancelled` (or error `cancelled`) | `cancelled` | — |
| recording or job `failed` | `transcription_failed` | `transcription_failed` · Abrir no web; none if `retryable` (the server tries again) |
| `summary` step `failed` | `summary_failed` | `summary_failed` · Abrir no web |
| job `queued` / `running` | `queued` / `transcribing` (step and progress) | — |
| one step `active`, else `pending` | `processing` (the step) | — |
| `summary` step `done` | `summary_ready` | — · **Copiar resumo** |
| `summary` step `skipped` | `no_summary` (the reason) | `no_summary` · Abrir no web only with `no_agenda_type` |
| `transcribed` with no summary step | `transcribed` | — |

  On the device: `recording`, `pending`, `uploading`, `uploaded` and `upload_failed`, the last
  with the `upload_failed` alert (the `last_error` as text) and the **Tentar agora** (Try now)
  action (`sync_now`).
- **The unknown is an intervention, on purpose.** A new server state — like "aguardando
  locutores" (awaiting speakers) — arrives as text and becomes "Precisa de você" with the code,
  the reason and **Abrir no web**, with no new app version; when the shared vocabulary gains the
  label, the window starts showing it. That is the case of the `speakers` step in `waiting`
  (contract 2.22.0): Rust keeps classifying it as a `needs_you` alert, and the panel labels it
  **Aguardando locutores**, in a warning tone, with the reason and **Abrir no web**.
- **Copiar resumo** (`copy_summary`): reads `Client::current_summary` (the same as the notice's
  and the synced folder's) and writes the `content_md` with the `tauri-plugin-clipboard-manager`
  — the same Markdown as the notification's "Copiar". With no finished summary, the error "O
  resumo ainda não está pronto" goes back to the row and nothing is copied. The window never uses
  `navigator.clipboard`.
- **Abrir no web** (`open_recording`): `<web_url>/gravacoes/<id>` through the `opener`, the same
  URL as the notice's (`sync::recording_url`). No panel command writes to the server.
- **The tray's Recentes section** (`recent::tray_section`) comes from the same local queue and the
  same snapshot of the `eclume-recentes` thread, with no API read of its own, cut at
  `tray_recent_count`. Each row becomes a `TrayEntry`: the "Título · Estado" label and the
  actions. The state is the window vocabulary's label rewritten in Rust (`recent::state_label`:
  "Resumo pronto", "Transcrevendo", the step's progress, "Aguardando locutores"…), because the
  native menu does not go through the window; with an alert, "Precisa de você (<estado>)". The
  title has at most 40 characters, with an ellipsis; with no title, the short date "dd/mm hh:mm"
  in the local time zone; the `&` becomes
  `&&` (menu mnemonic). The actions: **Copiar resumo** with `summary_ready`, **Abrir no web** with
  a remote id and **Tentar agora** with `upload_failed`. The header counts the alerts ("Recentes ·
  1 precisa de você"). Progress and the wait stay out of the section on purpose: the menu is only
  rebuilt when it changes ([desktop-gravacao.md](desktop-gravacao.md) §App and tray).

## Account and credential

The app side of the protocol in [server-mcp-e-dispositivos.md](server-mcp-e-dispositivos.md).

- **Device credential.** The person signs in with e-mail and password (`POST /devices/login`) or
  with the 6-character pairing code generated on the web (`POST /devices/pair`), sending
  `device_name` (the hostname, the same as the `capture`'s) and `platform` (`windows`, `macos` or
  `linux`). The `eclp_` secret that comes back is kept; on pairing, the e-mail comes from
  `GET /me`. Refusals become text: 401 gives "E-mail ou senha incorretos", `invalid_pairing_code`
  gives "Código inválido ou vencido" (any pairing 401), 403 `notice_required` gives "Aceite o
  aviso de responsabilidade na web do eclume e entre de novo aqui" and 429 gives "Muitas
  tentativas; tente em N s" (from the `Retry-After`). These routes have no retry: it is the
  person's action.
- **The vault** is the usual `PatStore`, because the credential is also `eclp_`: the OS keyring
  through `keyring` 4 (service `eclume-desktop`, account `pat`: Secret Service on Linux,
  Credential Manager on Windows, Keychain on macOS). With no keyring (a session without Secret
  Service), it goes to `pat` in the config directory with permission 0600, and the window warns;
  when the keyring comes back, the next save deletes the file. The secret never goes back to the
  window.
- **Each keyring access runs on its own thread.** `keyring`'s Secret Service does `block_on`
  internally and panics on a thread that already runs a Tokio runtime (a Tauri `async` command,
  the updater); the panic also poisons the vault's global mutex, and every later access panics
  too, bringing the app down on the next settings read. On its own thread `block_on` works, and
  a leftover panic becomes an error (and the `PatStore` falls back to the file). Whoever only
  needs the pinned CA (the updater) reads it from the config, without going through the keyring.
- **No dependency ties zbus to Tokio.** `ashpd` (the shortcuts portal on Wayland) comes in with
  the `async-io` feature, never `tokio`: with `tokio`, the keyring's and the notifications'
  `zbus::block_on` starts creating its own Tokio runtime and panics the same way when called from
  a Tokio thread. A new dependency that uses zbus follows the same rule.
- `config.json` gains `account: {email, token_id, server_name}`. `Config::connection(tem
  credencial)` decides the window: with no credential, `first_run`; a credential without
  `account`, `personal_token`; with both, `account`.
- **Who already uses a PAT** (0.1.x): with a PAT kept and no `account`, the app does not show the
  first run and keeps syncing. The Server tab says "Conectado com um token pessoal" and offers
  "Entrar com e-mail e senha", which swaps the PAT for the credential. Pasting a PAT left the
  screen; `ECLUME_PAT` still overrides everything, for dev and tests.
- **Sair** (Sign out) deletes the credential from the vault and the `account` and returns to the
  first run, without deleting the queue: the recordings wait for the next sign-in. Revocation
  stays on the web ("Desvincular"), because the contract has no route for the device to revoke
  itself.
- **"Testar conexão"** (Test connection) calls `GET /api/v1/me` with the credential and shows
  "Conectado · último envio 10:38" (the queue's most recent `synced_at`).

## First run, discovery and pinned CA

- **Known servers**, in order: the one **embedded in the installer** ("Veio com este instalador",
  `config::embedded_server`, [desktop-distribuicao.md](desktop-distribuicao.md)), those **found on
  the network** ("Encontrado na rede") and, under "Avançado" (Advanced), the **typed address**
  (the host alone is enough; `https://` is added on its own).
- **Discovery** (`sync/src/discovery.rs`, `mdns-sd`, pure Rust): looks for `_eclume._tcp.local.`
  for up to 3 s and reads the TXT `url`, `ca`, `v` and `name` that `eclume-server announce`
  publishes; the parser is pure, an announcement without `url` is ignored and the same address is
  not repeated.
- **Pinned CA** (`sync/src/pin.rs`): the app pins Caddy's **root**, never the leaf.
  1. downloads `<url>/downloads/eclume-root.crt` through a transport without verification
     (`UreqTransport::insecure`), used **only** for that file and without a credential;
  2. computes the SHA-256 of the first certificate's DER and compares it with the expected
     fingerprint (the installer's, the TXT's or the QR's); if they diverge, it stops before
     signing in;
  3. keeps **only that certificate** (`pin::root_from_pem` cuts the first block and re-reads it
     with the same DER; extra certificates never reach the disk) in
     `<config_dir>/servidor-pendente/servidor-ca.pem` and reads `GET /api/v1/server` trusting only
     it (`TrustMode::Pinned`): the descriptor's `ca_sha256` must be the same;
  4. on sign-in (also in pinned mode), the PEM moves to `<config_dir>/servidor-ca.pem`, which
     becomes the `ca_path`; from then on everything that talks to the server (sync, summary
     notice, mirror, "Testar conexão" and updater) trusts only it, and a chain that does not lead
     to that root is refused even if the OS trusts it.
- **Migration on open** (holetz/eclume#102): `AppState::open` calls `account::repair_pinned`,
  which runs `pin::trim_saved` only on the `ca_path` pinned by the first run (never on one chosen
  by hand). A file with more than one certificate is rewritten (temporary + `rename`) with only
  the first; the app deletes the credential and the `account`, writes the config and enters the
  changed-CA state (sync stopped, first run) with the `pin::CA_TRIMMED` warning, which tells the
  person to sign in again, change the password and unlink the old entry on the web. With a single
  certificate, the file is not touched and nobody needs to sign in again.
- **Only the installer waives the check** (`account::vouched_by_installer`): the mDNS TXT is not
  authenticated, and any machine on the network can announce another CA. With a typed or
  announced address (with or without `ca`), the screen shows the fingerprint in `.code-block`
  ("Confira com quem administra o servidor") and only lets the person in after "Confiar e
  continuar", which calls `confirm_server(url, ca_sha256)`. The lock is also in Rust: `sign_in` and
  `pair` refuse an unconfirmed `first_use` server, and `confirm_server` refuses when the prepared
  server is already another one (a newer choice finished first).
- A server that does not publish its own CA (404 on `eclume-root.crt`, with no expected
  fingerprint) uses the system roots; `http://` only applies in development: the release build
  refuses `http://` outside `localhost` and `127.0.0.1`.
- **With the account active**, the Server tab does not change the address or the CA: the
  credential and the pinned CA apply to that server ("Saia da conta antes de trocar o servidor ou
  a CA").
- **The next root** (holetz/eclume#101). With the pinned CA, the sync loop reads, at most every
  6 h (10 min after a failure), the descriptor through the pinned connection
  (`account::learn_next`): with `ca_next_sha256`, it downloads
  `/downloads/eclume-root-proxima.crt` through the same connection, checks the SHA-256 and writes
  a single certificate to `<config_dir>/servidor-ca.proxima.pem`; with no announcement, it deletes
  the kept one. Signing in again also deletes it.
- **The CA changed.** After a sync failure (upload or outcomes read) with the pinned CA,
  `account::ca_changed` downloads the root again and compares it with the kept one. If the served
  one is the kept next one, it reads the descriptor pinning the next one and, if the descriptor
  does not contradict it, replaces the pinned one with it (`rename`): sync and the updater carry
  on with no new sign-in. If it changed to another, sync stops with "O certificado do servidor
  mudou" and the window returns to the first run, where the person chooses the server and signs in
  again.
- Window **commands**: `discover_servers`, `prepare_server(url, ca_sha256?)` (returns `{name,
  url, ca_sha256, trusted_by}`, with `trusted_by` `fingerprint`, `first_use`, `system` or
  `unencrypted`), `confirm_server(url, ca_sha256?)`, `sign_in`, `pair`, `sign_out`, `test_connection`, `open_signup` (opens
  `<url>/cadastro`) and `pick_ca_file`.

## What the sync crate offers the mobile app

The mobile app ([mobile-app.md](mobile-app.md)) uses the same `eclume-sync`; the pieces below
exist for it and do not change the desktop.

- **`source` comes from the queue row** (`desktop`, `mobile` or `upload`): the phone records with
  `RecorderConfig { source: Mobile, .. }`, and the `HttpUploader` does not know where it came
  from. `HttpUploader::with_device_name` replaces the `capture.device_name` (on the phone, the
  device model, not the hostname).
- **`TrustMode`** (`transport.rs`): `PlatformPlus(ca_path?)` is the desktop's with a CA chosen by
  hand or with no server CA of its own (the platform verifier, or the native roots plus every
  certificate in the PEM); `Pinned(ca_path)` is the desktop's with the first-run CA and the
  phone's, and trusts **exactly one** certificate (`transport::pinned_cert`; a PEM with more than
  one is an error that names the file), without the OS roots or the `rustls-platform-verifier`,
  which on Android requires its own JNI initialization. `UreqTransport::with_trust(modo, user_agent, prazo)` accepts a total deadline smaller than the
  600 s default (the phone's network probe uses 3 s); `UreqTransport::pinned` is the pinned mode's
  shortcut.
- **`os-keyring` feature** (default): `OsKeyring` and the `keyring` crate only come in with it.
  Without it (the phone), `PatStore::new` uses `NoKeyring`, and the credential stays only in the
  private 0600 file; `cargo check -p eclume-sync --no-default-features` proves the crate compiles
  that way.
- **`parse_pair_url`** (`devices.rs`) reads the web's QR, `https://<host>/parear?codigo=<6>&ca=<64 hex>`,
  and returns `PairUrl { url, code, ca_sha256? }`. The text comes from the camera and is not
  trusted: another scheme, another path, a code that is not 6 alphanumerics (the hyphen of
  `K7Q-4MX` is accepted) or an invalid `ca` are refused before any network.
- **`platform()`** also returns `android` and `ios`, the values of the contract's
  `DevicePlatform`.
- In `eclume-audio-capture`, the **`mic`** feature turns on only `MicSource` (`cpal`, AAudio on
  Android), without the system audio backends; `backends` includes it.

## Server, extra CA and retention

| `config.json` field | Default | What it does |
|---|---|---|
| `web_url` | the embedded server, or `https://192.168.15.199:8443` in a build without it | server: the eclume web and, without `api_url`, the API; signing in writes the chosen server |
| `account` | — | the account the computer signed in to |
| `api_url` | — | API at another address (dev); `ECLUME_API_URL` overrides |
| `ca_path` | — | PEM with Caddy's internal CA: the one pinned by the first run or one chosen in Server · Advanced ("Escolher…") |
| `retention_days` | `7` | days the local file stays after confirmation; `0` deletes it at once, `null` keeps it forever |

- **TLS, by the origin of `ca_path`** (`account::trust_for`, which `UploaderConfig.trust`,
  `Net::verified` and `AppState::trust` follow): the CA pinned by the first run
  (`<config_dir>/servidor-ca.pem`) is `Pinned`, only it; a CA chosen by hand is `PlatformPlus`,
  the OS's native roots plus the PEM's certificates; with no `ca_path` (a public certificate, or
  dev `http://`), the platform verifier, which sees the CA installed in the OS by the host
  runbook. `AppState::trust` reads only the config, without the keyring. An unreadable PEM or one
  without a certificate is refused on save.
- **Retention:** only `synced` rows with a `remote_id` lose the file, and the row stays in the
  queue with `purged_at`. Nothing the server has not confirmed leaves the disk.

## Tests

- Unit, without an OS: classification with mocked signals, debounce with an injected clock, the
  automatic recording machine, the protocol over a scripted transport (new upload, dedup,
  resumption, vanished upload, retry and `Retry-After`, `401` without retry, renewed presigned
  URL), sign-in and pairing with the refusals, pinned CA (fingerprint, TOFU, divergent descriptor,
  PEM with two certificates in the download, on write, in `trim_saved` and in `Pinned` mode), the
  mDNS TXT parser, the account in the state over a scripted network (`account::tests`: sign in,
  sign out, changed CA, old PAT, trust by the CA's origin and `repair_pinned`), the migration on
  open (`state::tests`), the updater's roots, PAT with a fake keyring, retention and config, and
  the recent panel (`recent::tests`: the phase of each state, the alerts, the unknown as
  `needs_you`, the merge of the queue with the page without duplicating, the cut at N and the
  interval). Real mDNS listening stays in an `#[ignore]` test.
- Integration with the contract mock (`tests/mock.rs`), skipped without `ECLUME_MOCK_URL`. The
  fixtures' part URLs point to `127.0.0.1:4010`, so the mock runs on the same machine as the
  tests. On the build host, the compose comes up from inside the synced directory, because the
  bind mount of `../contracts` must exist on the host:

```bash
remote-run . 'docker compose -p eclume-13-mock -f deploy/docker-compose.mock.yml up -d --wait'
remote-run . 'ECLUME_MOCK_URL=http://127.0.0.1:4010 cargo test --manifest-path desktop/Cargo.toml -p eclume-sync'
remote-run . 'docker compose -p eclume-13-mock -f deploy/docker-compose.mock.yml down -v'
```

- Windows: verification through the manual `desktop-platforms.yml` workflow (macOS is out until
  the repository is public, see [monorepo.md](monorepo.md)); the field test (ConsentStore, toasts
  with buttons) belongs to `holetz/eclume#16` and `holetz/eclume#28`.
