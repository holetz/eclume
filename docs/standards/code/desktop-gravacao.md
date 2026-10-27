---
type: standard
title: Recording in the desktop app
description: The desktop app records mic and system audio mixed into Ogg/Opus mono 16 kHz (24 kbps), and the voice note with the microphone only, stopped by silence; it registers each recording in a local SQLite queue (v6, with kind, date origin, source, markers, title, agenda type and language chosen on stop, and the server title) with states recording → pending → syncing → synced or failed, resumption, backoff and retention, and exposes the Uploader and MeetingDetector traits that sync and detection implement — this is the format, the lifecycle, the pause and audio time, the silence detector, the markers and the extension points; the crates are shared with the mobile app.
resource: desktop/crates/recorder/**, desktop/crates/audio-capture/**, desktop/src-tauri/src/**
tags: [code, desktop, audio, opus, fila, sqlite, tauri]
timestamp: 2026-10-05
audience: both
authority: current
source: holetz/eclume#6, holetz/eclume#28, holetz/eclume#40, holetz/eclume#41, holetz/eclume#57, holetz/eclume#118, holetz/eclume#121, holetz/eclume#147
maintainer: holetz
---

# Recording in the desktop app

The desktop app records meetings on the user's machine and keeps them until sync. Everything that
does not depend on a device lives in the `eclume-recorder` crate (`desktop/crates/recorder`),
testable with synthetic audio; the real capture lives in `eclume-audio-capture`
(`desktop/crates/audio-capture`).

## Sources

- Two sources per recording: the **mic** (`cpal`) and the **system audio** (loopback) —
  PipeWire on a sink's monitor, falling back to the Pulse monitor, on Linux; WASAPI loopback
  on an endpoint on Windows; Core Audio process tap on macOS (14.2+).
- **Chosen in Settings · Audio**, each source with "Nenhum" (None):

| Source | `config.json` | Values |
|---|---|---|
| Microphone | `mic` | `null` (system default), the device name, or `"none"` |
| System audio | `system_source` | `"follow"` (default: follow the output in use), the id of an output, or `"none"` |

  `list_input_devices()` lists the microphones and `MicSource::open_named` opens the chosen one;
  `list_output_devices()` lists the outputs (Linux: the sink name, with the description as label;
  Windows: the active endpoints; macOS: empty, the tap follows the output in use and ignores an id
  with a warning) and `SystemSource::open_target` opens the chosen one. A choice that disappeared
  falls back to the default, with a warning in the window (`fell_back`). The old `system_audio`
  boolean is still read (`false` becomes `"none"`) and is no longer written. Both sources set to
  None are refused ("Escolha ao menos uma fonte de áudio"); with the microphone set to None,
  "Nova nota" and the shortcut answer "A nota precisa de um microfone".
- **Test per source.** "Fale para testar" (microphone) and "Toque algo para testar" (system) open
  the source for up to 10 s for the meter only, without recording (`source_test`,
  `source_test_meter`); one test at a time, and starting another ends the current one. The button
  becomes "Parar" (`source_test_stop`), which closes the source at once, and is disabled with the
  source set to None. Changing the source or leaving settings also stops the test.
- Every source implements `AudioSource`: `sample_rate()` and `read(timeout)`, which returns mono
  `f32` samples at the native rate — `Some(vec![])` when the timeout expires with no samples,
  `None` when the source has ended. The rate can change mid-recording and is re-read on every
  read. Two methods with defaults complete the trait: `state()` (`SourceState::Live` or
  `Reconnecting { since }`) and `dropped_samples()` (drops due to a full ring); the `impl` for
  `Box<T>` forwards both.
- **The microphone reconnects.** `MicSource` is a `Reconnecting` (`audio-capture/src/reconnect.rs`)
  over the `cpal` opener: when the ring closes (stream error, device unplugged, Bluetooth profile
  switching), the source releases the old ring on a separate thread and reopens, also on a
  separate thread, with a wait of 0.5 s doubling up to 5 s, never giving up while the recording
  exists. While reconnecting, `read` delivers **silence at the pace of the clock**, at the last
  rate: the track does not fall behind, and duration, markers and the two tracks stay aligned
  with the meeting. Each attempt resolves the choice again (the name, else the default with
  `fell_back`). A follower checks every 2 s which microphone should be in use (with "system
  default", the OS default; with a name, that one when it reappears) and requests the switch
  after two consecutive readings, the criterion of the Windows system audio's
  `EndpointFollower`. The `None` of `read` still means a real end.
- The recording loop copies each track's state and the drops into the `Progress`
  (`source_states()`, `dropped_samples()`) on every turn; new drops go to the log at most every
  10 s, and the total enters the "recording X closed" line.
- **Microphone out:** the reaper (1 s) calls `AppState::watch_sources()`. A loss above 5 s (the
  Bluetooth profile switch takes 1 to 3 s) puts "gravando sem microfone: tentando reconectar" in
  the window, "sem microfone" in the tray line and the notification "Microfone perdido · gravando
  sem a sua voz, tentando reconectar"; the return clears the warning.
- Recording proceeds with whatever opens: a source that fails becomes a warning in the window
  ("gravando sem …"), and it is only an error when none opens.

## File format

| Item | Value |
|---|---|
| Container | Ogg, one logical stream, `OpusHead` and `OpusTags` on their own pages |
| Codec | Opus, `Application::Voip`, 24 kbps, 20 ms frames |
| Channels and rate | mono, 16 kHz (`input sample rate` = 16000 in the `OpusHead`) |
| Granule | at 48 kHz; the last page's is `pre-skip + amostras reais × 3` (real samples), so the duration is exact |
| Pages | one every ~1 s of audio, flushed to disk on close |

It is the same format the browser produces on upload
([formato-audio-upload.md](formato-audio-upload.md)); only the bitrate differs (24 kbps here,
with long meetings in mind). The mix resamples each source to 16 kHz (sinc, `rubato`), sums with
a hard limiter at ±1.0 and, if a source falls more than 200 ms behind the others, pads it with
silence — so a suspended sink monitor or an idle WASAPI loopback (which delivers no packet at
all while nothing plays) does not stall the recording. That silence becomes a debt of at most
200 ms, deducted **only from the surplus**: from the samples the source delivers ahead of the
longest queue among the others, the case of a delayed burst. The source that resumes delivering
in real time after a silence comes in aligned and whole; deducting the debt from every new sample
erased the system audio after the first pause (holetz/eclume#28).

## Voice note and silence stop

- `AppState::start_note()` opens **only the microphone**, through the same `capture.rs` and with
  the chosen device: a note is the speech of whoever records, and the system audio would bring in
  music and notifications. The queue row is born with `kind = 'note'`, and the upload carries
  `kind: note`.
- **Detector** (`recorder/src/vad.rs`, pure), over the mixed 16 kHz samples the `record_loop`
  already produces, in 20 ms frames (320 samples):

| Parameter | Value |
|---|---|
| Level | the frame's RMS in dBFS |
| Noise floor | the 20th percentile of the levels of the last 3 s (150 frames, only those before the frame); a fan switched on midway becomes the floor in about 1 s. Digital silence (below −90 dBFS) enters the window but never becomes the floor: when the percentile falls on it, only the absolute limits apply, so that the zeroed pauses of a noise suppressor do not drag the floor up to the speech itself |
| Voice | enters with `nível > max(piso + 12 dB, −55 dBFS)` and holds with `nível > max(piso + 8 dB, −58 dBFS)` (hysteresis) |
| Sustained voice | the current frame is voice, and at least 5 of the last 10, the current one included, are too (100 ms in 200 ms): only it resets the silence and counts as voice heard. A click, a key or a slamming door do not restart the count |
| Speech gate | after the first sustained voice, only a frame at most 25 dB below the recent speech peak resets the silence (the peak falls 2.5 dB/s). A breath, a distant "hum" or a chair stay out: in a real note, a breath 30 dB below the speech held the stop for 1.8 s longer |
| `Silence` | the silence, counted since the last frame of sustained voice, exceeded the configured value (2, 4 or 8 s; default 4 s), and only after there has been sustained voice. The window's countdown only appears after 300 ms without voice, so it does not flicker between syllables |
| `NoSpeech` | no voice in the first 10 s |
| Meter | the last 16 levels, from −60 to 0 dBFS mapped to 0 to 1 |

- With "Nunca" (Never; `note_silence_s: null`), the detector only feeds the meter. Energy with an
  adaptive floor is enough for "the person stopped talking" with a single speaker close to the
  microphone, with no native dependency and testable with synthetic audio; a trained VAD (WebRTC
  via FFI, Silero via `onnxruntime`) does not pay off.
- **Session.** `session::start` receives `StartOptions { kind, stop_after_silence }`. A shared
  `Progress` exposes `position_ms()` (recorded samples ÷ 16), `meter()`, `level()` and
  `stop_reason()`. The
  `record_loop` ends on its own on `Silence` or `NoSpeech`, and the reaper, which closes finished
  recordings every 1 s, decides by the reason: `SourcesEnded` gives the usual warning; `Silence`,
  the notification "Nota salva · 42 s · processando no servidor"; `NoSpeech` **discards** the note
  (`queue.discard` and the file deleted) with "Nota descartada · não ouvimos voz".
- **Manual stop** by the same shortcut, by the button ("Parar nota") or by the tray; a stop by
  hand is never discarded. With a recording in progress, "Nova nota" answers "Já há uma gravação
  em andamento", and the shortcut does not open another capture.
- The window shows the meter (`note_meter`, every 100 ms) and "Silêncio · para em N s". Nothing
  else opens (variant A): the tray switches the icon and shows the time — in the title, on macOS
  and Linux; in the tooltip, on Windows, whose notification area shows no text.

## Pause, audio time and level

- `ActiveRecording::set_paused(bool)` pauses without closing the sources: the loop keeps reading
  and mixing, and discards what it reads. Reopening the microphone in the background would run
  into the phone's restrictions (Android 14+), and the open device gives instant resumption.
- **Audio time** is the recorded time without the pauses: `audio_ms()` (the `Progress`'s
  `position_ms()`) is the markers' `at_ms` and becomes the upload's `duration_ms`. The screens'
  clock shows audio time.
- `level()` is the RMS of the last recorded stretch, from 0 to 1, and drops to 0 when paused: it
  is the continuous meter the UI reads every 100 ms (the note's `meter()` remains the detector's
  dBFS history).
- `RecorderConfig` carries, besides `dir` and `bitrate`, the `source` written to the queue
  (`desktop`, the default, or `mobile`) and `ask_details`: with it, `stop` leaves the row with
  `details_pending`.

## Markers

- `AppState::add_marker(note)` marks the active recording's `position_ms()` — the position in the
  **audio**, not the clock, so that a source gap does not misalign the marker — with a
  `client_id` UUID v4, in the queue's `markers` table. `set_marker_note` edits the note (up to 500
  characters) while the recording has not been uploaded.
- Entry points: the window's "Marcador" button (with the last marker's note), the tray's
  "Adicionar marcador" item (only while recording) and the global shortcut, which opens nothing
  and does not notify, so as not to disturb the meeting. The tray tooltip says "3 marcadores".
- **Automatic markers:** a microphone loss above 5 s marks "microfone perdido" at the instant of
  the drop (the position in the audio minus the time out), and the return marks "microfone de
  volta". On the phone, also "silenciado pelo sistema" ([mobile-app.md](mobile-app.md)).
- Markers go up **with the upload** (`UploadCreate.markers`), idempotent by `client_id`:
  resumption and the deduplicated upload resend the same ones, and the server merges them without
  duplicating (holetz/eclume#34).

## Files and queue

- The data lives in the app's data directory (`app_data_dir`): `queue.sqlite` and `gravacoes/`.
- The recording is born as `gravacoes/<id>.ogg.part` and becomes `<id>.ogg` on stop.
- The queue is the `recordings` table (`id`, `path`, `started_at`, `ended_at`, `duration_ms`,
  `bytes`, `status`, `interrupted`, `attempts`, `last_error`, `remote_id`), with instants in Unix
  milliseconds. Schema v2 (`user_version = 2`) adds `upload_id` and `sha256` (upload resumption),
  `next_attempt_at` (backoff), `synced_at` (server confirmation), `purged_at` (local file deleted
  by retention) and `meeting_app` (the detected meeting's app, in the contract's vocabulary).
  Schema v3 (`user_version = 3`) adds `kind` (`meeting|note`, default `meeting`),
  `recorded_at_source` (`capture|file_metadata|user`, default `capture`), `source`
  (`desktop|upload`, default `desktop`), `original_name` and `content_type` (null is
  `audio/ogg; codecs=opus`), and the table `markers (client_id PRIMARY KEY, recording_id, at_ms,
  note, created_at)`. Schema v4 (`user_version = 4`) adds `title` and `agenda_type_id` (chosen on
  stop and carried in the `UploadCreate`), `details_pending` (0/1) and the `mobile` value in
  `source`. Schema v5 (`user_version = 5`, holetz/eclume#118) adds `server_title`, the title the
  server gave the recording, read from the listing by `?since=` (desktop) or in the network cycle
  and in the detail (phone); the queue shows the title given on stop, else this one. Schema v6
  (`user_version = 6`, holetz/eclume#121) adds `language`, the recording's transcription language
  (`auto` requests detection), which the upload sends ahead of the device language. A v1 to v5
  queue gains the columns on open, without losing rows.
- v3 methods: `set_kind`, `begin_import` (the import is born `pending`,
  [desktop-importacao.md](desktop-importacao.md)), `discard`, `add_marker`, `set_marker_note` and
  `markers(recording_id)`. From v4: `set_source`, `set_details_pending`, `save_details(id, título,
  tipo, idioma)` (empty values become null; releases the sync; only before the upload; the
  language since v6) and `release_details_pending`. From
  v5: `set_server_title(remote_id, título)`, which returns whether any row changed.

```
recording ──stop──▶ pending ──claim_next──▶ syncing ──▶ synced ──retention──▶ (purged_at)
    │                   ▲                        │
    ├─crash / stuck .part: recover_orphans ──┘   └──▶ failed ──retry_due / retry_failed──▶ pending
    │    (on open or a sweep every minute; interrupted = 1)
    └─recording failure or panic: stop closes anyway (interrupted = 1)
```

- **A stop that always closes:** `ActiveRecording::stop` keeps the recording thread's error or
  panic in the log instead of aborting; the reason becomes `StopReason::Failed` (a panic with no
  reason too). The `.part` is renamed with up to 5 attempts (200 ms doubling, ~3 s: antivirus and
  the Windows indexer hold the file for moments) and the row becomes `pending` with the duration
  from `Progress::position_ms` and, when the recording failed, `interrupted = 1`
  (`Queue::mark_interrupted`). `stop` only returns an error when the queue fails or the `.part`
  stays stuck; then the row stays in `recording` for the sweep.
- **Recovery:** `session::recover_orphans(fila, vivas)` settles each row in `recording` whose id
  is not in `vivas`: it renames the `.part` (the Ogg is readable up to the last written page) and
  moves it to `pending` with `interrupted = 1`, one row at a time: a refused `rename` leaves that
  row as it is, in the log, and moves on. On open, the app calls `session::recover` (orphans with
  no live ones, plus whatever stayed in `syncing` back to `pending`, and every `details_pending`
  dropped: the sheet that held the sync no longer exists); opening never fails because of a stuck
  `.part`. With the app open, the reaper calls `AppState::sweep_orphans` every minute, with the
  active recording's id read and held under the state lock (order state → queue), and no
  recording starts in the middle of the sweep.
  **Rule:** the sweep only touches a `recording` row whose id belongs to no live session of the
  process; a session being stopped also counts as live.
- `claim_next` reserves only `pending`, and skips the one with `details_pending` until
  `DETAILS_WAIT_MS` (10 min) after the end: a sheet left open and forgotten does not hold the sync
  forever. `mark_failed` schedules `next_attempt_at` by
  `retry_backoff_ms` (30 s doubling on each attempt, up to 1 h); `retry_due(agora, max)` returns
  to the queue the failures whose time has come, and `retry_failed(max)` returns them at once.
- `purge_candidates(até)` lists the `synced` ones with a `remote_id` whose file still exists;
  `mark_purged` records the removal. Nothing the server has not confirmed leaves the disk.

## Extension points

Implemented by `holetz/eclume#13`; the detail is in
[desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md).

- `Uploader::upload(&QueuedRecording) -> Result<String>` sends the file and returns the remote id;
  `sync_pending(&Mutex<Queue>, &dyn Uploader)` goes through every `pending`, isolates each failure
  in its own row and does not hold the queue during the upload. The implementation is the
  `eclume-sync` crate's `HttpUploader`, which keeps the upload in progress in the shared queue
  (`AppState::shared_queue()`).
- `MeetingDetector::poll() -> Option<MeetingEvent>` (`Started { app }` / `Ended`), polled every
  second; the implementation is the `eclume-detect` crate's `DebouncedDetector`. The recording it
  starts uses `AppState::start_recording_as` with the origin (manual or detection, and the app),
  and the manual one still goes through `start_recording`.
- `AppState::set_syncing(bool)` turns on the "Sincronizando" (Syncing) state the tray shows.

## App and tray

- The window is born hidden and closing it only hides it; the app lives in the tray
  (AppIndicator on Linux, menu bar on macOS, notification area on Windows). On Linux the click
  only opens the menu, so every action lives in it, like the DS "Tray menu" frame: the status
  line, "Iniciar gravação" or "Parar gravação", "Nova nota", "Adicionar marcador" (only while
  recording), "Importar arquivo…", "Abrir o eclume", "Abrir a biblioteca na web" and "Sair" (which
  closes the recording in progress first), with the shortcuts as accelerators. The meeting
  question comes in as two items. The window's UI is in
  [desktop-interface.md](desktop-interface.md).
- **Recent items in the menu** (holetz/eclume#147): between "Importar arquivo…" and "Abrir o
  eclume", so as not to move "Iniciar gravação", the Recentes section with the last
  `tray_recent_count` recordings (1 by default; 0 hides it): the disabled header ("Recentes", or
  "Recentes · N precisam de você"), "Nenhuma gravação recente" when empty, and one "Título ·
  Estado" line per recording ([desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md) §Recent
  recordings panel). A line with an action is a **submenu** with "Copiar resumo", "Abrir no web"
  and "Tentar agora", depending on the phase; with no action, an item that opens the window. The
  ids carry what the action uses (`recent-copy:<id
  remoto>`, `recent-open:<id remoto>`, `recent-retry:<id local>`, `recent-show:<chave>`). Copy
  reads the API on a thread and reports through a notification ("Resumo copiado" or the failure),
  the only feedback the tray has; Try now calls `sync_now` on a thread.
- **The menu is only rebuilt when it changes.** `tray::apply` builds the section on every update
  and only calls `set_menu` when the question, the recording, the shortcuts or the Recentes
  section changed; progress does not enter the section, so transcription progress does not
  rebuild the menu.
- **Limits of the native menu.** Linux (libappindicator, through DBusMenu): clicking the icon only
  opens the menu; an item has no icon or tooltip; the text is plain, with no bold or color; each
  `set_menu` re-exports the whole menu and closes the open menu, which is why nothing that changes
  on every read goes into it; submenus work. Windows (Win32 popup menu): the menu is built on
  open, so replacing it is cheap; submenus work; there is no label beside the icon. On both, `&`
  is a mnemonic (the title escapes it as `&&`; the `_` changes it, escaping in GTK) and state
  always goes as text.
- The eclume web address comes from `config.json` in the app's config directory (`web_url`: the
  server the person signed in to, [desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md)) and
  can be overridden by `ECLUME_WEB_URL`.
- Opening devices can take seconds: start/stop runs off the UI thread.
- **Stop outside the lock:** `AppState::stop_recording` takes `active` under the state and keeps
  the id in `stopping`; with no lock at all, `ActiveRecording::close` (signal, join of the
  recording thread, driver teardown, `fsync`, `rename`); with the queue, `Closed::deliver`; under
  the state, clears `stopping`. While `stopping` exists, the visible state stays "Gravando"
  (Recording), starting or stopping again is `Busy` and the orphan sweep counts the id as live.
  "Sair" (Quit) closes the recording on a thread and calls `app.exit(0)` at the end. No join of a
  capture thread waits without a deadline: `join_with_deadline` (`eclume-audio-capture`, 3 s)
  releases the stuck thread with a warning in the log.
- **Panic-isolated loops:** the reaper, the sync, the synced folder, the detection and the note
  clock run each pass through `supervise::pass` (`catch_unwind`); a panic stays in the log (with
  the hook's backtrace) and the loop waits 1 s doubling up to 60 s, reset on success. The updater
  runs each check in a subtask and handles the panic `JoinError` the same way. A poisoned mutex
  does not make the app unusable: the state and the queue carry on through `into_inner`, with the
  poisoning in the log.
- **"In progress" flag only through a guard:** `syncing`, `mirror.running` and `importing` turn
  off in the `Drop` of a guard (`AppState::syncing`, `mirror_running`, `import_guard`), which takes
  the state even when poisoned: "Sincronizando" and "Já há uma importação em andamento" do not stay
  stuck after a panic.
- **`#[tauri::command(async)]` commands:** a synchronous command only reads or writes memory and
  the SQLite queue. Keyring, external process (`gsettings`), autostart registration, files outside
  the queue and network go in `#[tauri::command(async)]` (today `settings`, `save_settings`,
  `sign_out`, `storage_info`, `confirm_server`, `open_data_dir`, `open_log_dir`, plus the network
  ones). Opening Settings does not query the keyring: the credential's origin is cached in the
  state, updated on sign-in, sign-out and save. An `async` command never calls a Tauri API that
  dispatches to the main thread (shortcuts, tray, window) with the state or the queue held.
- When the recording stops on its own because the sources dropped or because the recording
  failed, the reaper (every second) closes the row and an OS notification goes out: "A gravação
  parou" with "<tempo>
  salvos · as fontes de áudio caíram" or "<tempo> salvos · falha ao gravar"; the window shows the
  same warning.
- `config.json` is written through a neighboring temporary file (`.config.json.tmp`) with
  `sync_all` and a rename; on failure, the temporary file is deleted. Opening only writes it when
  the opened version changes `last_version`. An unreadable file is renamed to
  `config.json.ilegivel-<ms>` before the default applies, and the window warns "A configuração
  estava ilegível e voltou ao padrão; a cópia está em …".
- The tray (menu, icon, title and tooltip) is only touched on the main thread. The Tauri setters
  (`set_text`, `set_menu`, `set_icon`, `set_title`, `set_tooltip`) dispatch to it and block until
  the reply: a background thread calling them while holding a lock the main thread also uses would
  freeze the app (#83). Background code requests the update through `tray::refresh` or
  `refresh_ui`, which runs at once on the main thread and, from another thread, only enqueues;
  whoever runs reads the state of the moment.
- The log (`info`, or the `RUST_LOG` filter) goes to stderr and to `eclume.log` in the app's log
  directory (`app_log_dir`: `%LOCALAPPDATA%\io.github.holetz.eclume\logs` on Windows,
  `~/.local/share/io.github.holetz.eclume/logs` on Linux, `~/Library/Logs/io.github.holetz.eclume`
  on macOS). Above 5 MB, the file becomes `eclume.log.1`, on open and also with the app open
  (the `Tee` counts the bytes and rotates under the `env_logger` lock). On Windows the release
  has no console, so the file is the only record of capture, sync and update failures.
  The first line of each open carries the version and the OS. A panic goes to the same log (its
  own hook) with the thread, the location and the backtrace: the default hook only writes to
  stderr, which an app opened from the system menu does not keep anywhere the person can find.
