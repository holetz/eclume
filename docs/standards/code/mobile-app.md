---
type: standard
title: Mobile app
description: The eclume mobile app (Tauri 2, Android) is a portable microphone — a React UI over the DS, Tauri commands and the estado event over eclume-mobile-core (the desktop recording and sync crates), and the native Kotlin plugin through the JNI bridge (microphone-type foreground service, notification, NsdManager, unmetered Wi-Fi, WorkManager, installer); the connection through the three paths with the pinned CA, the eclume network, the session with audio time and markers, the sync, the screens and the proof on the emulator.
resource: mobile/**
tags: [code, mobile, android, tauri, gravacao, sync, mdns, tls]
timestamp: 2026-10-05
audience: both
authority: current
source: holetz/eclume#41, holetz/eclume#122, holetz/eclume#130, holetz/eclume#114, holetz/eclume#123, holetz/eclume#117, holetz/eclume#118, holetz/eclume#121, holetz/eclume#102, holetz/eclume#101, holetz/eclume#144
maintainer: holetz
---

# Mobile app

The phone is a **portable microphone**: it records in Ogg/Opus mono 16 kHz with the screen locked,
marks instants with an optional note, keeps the recordings away from the server and syncs on its own
on the Wi‑Fi of the server's network, with the same resumable upload as the desktop. **It does not
read transcripts or summaries**: that belongs to the web, and the phone does not notify the end of
processing (it only talks to the server on the eclume Wi‑Fi; the notice belongs to the desktop and
the web, holetz/eclume#118). Android only: iOS is out of scope, with no open spec (the plugin refuses
iOS in `mobile/plugins/gravador/src/lib.rs`; the core, the UI with `data-os` and the plugin's
interface do not close the door on a Swift side). The pillar's layout and commands are in
[monorepo.md](monorepo.md#mobile--npm-and-cargo-workspace-in-mobile); the distribution, in
[mobile-distribuicao.md](mobile-distribuicao.md).

## Architecture

```
UI (React, ui/src) ──invoke/listen──▶ src-tauri (comandos, evento estado) ──▶ eclume-mobile-core
                                            │ run_mobile_plugin                    ▲
                                            ▼                                      │ JNI (EclumeCore)
                          plugin eclume-gravador (Kotlin) ─────────────────────────┘
                          serviço, notificação, NsdManager, rede, aparelho, WorkManager, instalador
```

- **`eclume-mobile-core`** (`mobile/crates/core`), with no Tauri and testable on Linux, reuses the
  `eclume-recorder` (encoder, SQLite queue, recovery), the `eclume-sync` (resumable upload, pinned
  CA, login and pairing) and the `eclume-audio-capture` with the `mic` feature (the `MicSource` via
  `cpal`, AAudio on Android). What the sync crate offers the phone is in
  [desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md#what-the-sync-crate-offers-the-mobile-app);
  pause, audio time and the v4 queue, in [desktop-gravacao.md](desktop-gravacao.md).
- **One core per process**: `OnceLock<Mutex<Core>>` (`iniciar`, `global`), independent of the
  `tauri::App`. The Activity may die and come back while the service records, and the WorkManager
  calls the core with no Activity: Tauri and JNI are two doors to the same core.
- **Network outside the lock.** Whatever talks to the network (the probe, the sync, the
  authenticated reads, the update download) is assembled under the lock as a plan
  (`PlanoDeLeitura`, `PlanoDeSync`, `PlanoDeDownload`), runs without it and comes back through a
  short method. The UI reads the state every 250 ms without waiting for the network.
- **Folders:** everything lives in the app's data folder (Tauri's `app_data_dir`, Android's
  `dataDir`): `eclume/` with `config.json`, `ca.pem`, `queue.sqlite` and `gravacoes/`, and
  `no_backup/` (the `noBackupFilesDir`) with the `device-token` 0600 (a private app file, not
  encrypted with the Android Keystore). The manifest has `android:allowBackup="false"` and
  `dataExtractionRules` that exclude everything from cloud backup and from device-to-device transfer
  (Android 12+). The `SyncWorker` opens the core with the same folder (`context.dataDir`); opening is
  serialized, so the screen and the worker do not run recovery twice.

## Connection and credential

- **Three paths to the pinned CA** (`conexao.rs`; the protocol is the one in
  [server-mcp-e-dispositivos.md](server-mcp-e-dispositivos.md#ca-pinning-by-the-apps)):
  1. **Discovered** through mDNS: the downloaded root must match the TXT `ca`, and even so the
     person checks the fingerprint before sending e-mail and password, because the TXT is not
     authenticated;
  2. **QR** from the web (`pair_url`, read by `parse_pair_url`): the fingerprint comes from the
     web's authenticated screen, and pairing finishes with no password and no check. A QR **without
     `ca`** (the root not yet published) waives nothing: it goes to the check, and the code is only
     exchanged after "Confiar";
  3. **Typed address** (with no scheme it becomes `https://`): TOFU, with the fingerprint in blocks
     of 4 (`3F9A 12C4 …`) to check against the web before "Confiar".
- Once the root is pinned, the transport is `TrustMode::Pinned` (only the `ca.pem`), and the
  already pinned `GET /api/v1/server` confirms the `ca_sha256` before saving the server in the
  config. The new root goes to `ca.pem.novo` and only replaces the `ca.pem` after that
  confirmation. The `ca.pem` holds **exactly one** certificate, the one of the checked fingerprint:
  `pin.rs` saves only the first of `eclume-root.crt`, and pinned mode refuses a PEM with more than
  one.
- **Migration on open** (holetz/eclume#102): with a server in the config and `ca.pem` present,
  `Core::abrir` runs `pin::trim_saved` on the `ca.pem`. A file with more than one certificate is
  rewritten with only the first, and the credential is erased with the reason `pin::CA_TRIMMED`
  (`Conexao::perdeu_credencial_por`), which tells the person to sign in again, change the password
  and unlink the old entry on the web. With a single certificate, nothing changes.
- **Next root** (holetz/eclume#101). The probe that confirms the pinned CA stores the next one the
  descriptor announces (`ca_next_sha256`): it downloads `/downloads/eclume-root-proxima.crt` over
  the same pinned connection, checks it and saves a single certificate in `ca.proxima.pem`
  (`pin::learn_next`); with no announcement, it erases the stored one, and so do pinning another
  server or signing out. When the probe yields `CaMudou` and a next root is stored, the core reads
  the descriptor pinning the next one (outside the lock) and, if it confirms it, swaps
  `ca.proxima.pem` for `ca.pem` (`rename`) and saves the new fingerprint in the config
  (`Conexao::promover_proxima`): the probe counts as ok and the device stays paired. With no next
  root, or with another root, it stays `ca_mismatch`.
- The `sem_credencial` phase carries an optional `motivo` (left out of the JSON when empty), which
  the Entrar screen shows in an `.alert.alert-warning` above the form; it goes away after signing
  in.
- The commands that talk to the server to connect (`conectar_*`, `confiar_ca`, `entrar`, `parear`)
  are `async` and run on a blocking thread, never on the main thread. Switching servers erases the
  previous one's credential.
- **Credential:** `POST /devices/login` or `POST /devices/pair` with `device_name` = `Build.MODEL`
  (the name the web lists and that markers carry) and `platform: android`. The `eclp_` secret goes
  to the `PatStore` with no keychain (the private file). Refusals become text in the sync crate,
  including the 403 `notice_required` ("Aceite o aviso … na web e entre de novo aqui").
- **401** on any authenticated call (noticed by the transport during sync, and by the reads of
  agenda types and stages, marked with `CredencialRecusada`) erases the token and leads to the
  Entrar screen, without touching the local recordings.
- **"Sair e esquecer o servidor"** erases the token, the CA and the server from the config; the
  waiting recordings stay and go up to the next paired server. The screen reminds the person to
  unlink the device on the web: a device token does not revoke itself.

## eclume network and sync

- **On the eclume network** = unmetered Wi‑Fi (the plugin, via `registerDefaultNetworkCallback`)
  **and** the `GET /api/v1/server` probe answering within 3 s, through the pinned CA, with the same
  fingerprint (`rede.rs`). States: `away`, `on_network`, `syncing {i, n, pct, bytes_s}`,
  `ca_mismatch` (the root changed, or TLS refused the chain) and `sem_credencial`.
- **The probe runs** when the app opens, on every network change (the device is read every 5 s),
  every 60 s with the app visible, after stopping a recording and on "Sincronizar agora". Off
  unmetered Wi‑Fi it does not run, and no byte leaves over mobile data.
- **Sync** (`sync.rs`): in `on_network`, with automatic sync on or through "Sincronizar agora"
  (which returns failures to the queue without waiting for the backoff), the `sync_pending` with the
  `HttpUploader` in pinned mode, `source: mobile`, the device's `capture.device_name` and
  `client_version: eclume-android/<versão>`. Per-part progress (bytes sent, rate) comes from the
  transport (`Contador`), which also notices the 401.
- The recording with `details_pending` (the "Gravação salva" sheet open) waits up to 10 min or until
  Salvar/Pular. After the sync, with "Excluir depois de sincronizar", retention erases the files
  confirmed more than 7 days ago; "Excluir sincronizadas" (the low-storage notice) erases them now.
- The sheet's **agenda types** are cached in the config and reread when the probe runs
  (`GET /agenda-types`, which since 2.4.0 accepts the device credential's `recordings:read`).
- **In the background**, the WorkManager's `SyncWorker` (`UNMETERED` only) uploads with the app
  closed. Triggers: the 15-min periodic one and a pass on open (`KEEP`), and `agendarSync` on Parar
  (with the sheet's deadline, 10 min), Salvar and Pular, under the unique name
  `eclume-sync-ao-conectar` with `APPEND_OR_REPLACE`: it chains after a sync in progress, without
  cancelling it. The worker is a `CoroutineWorker`: `sondarPendentes` (probe and pending, starting
  from the unmetered Wi‑Fi the WorkManager guarantees) decides; on the eclume network and with
  something to upload, it enters the **`dataSync` foreground** (channel `sync`, "Enviando N
  gravações"), outside the WorkManager's 10-min limit; if Android refuses (Android 12+ without the
  battery exemption), it goes on as ordinary work. The sync (`syncPendentes`, `ciclo_do_worker`)
  runs on `Dispatchers.IO`. The result is `success` when everything went up or there was nothing to
  upload, and **`retry`** when the cycle errored, was interrupted or some recording failed
  (exponential backoff from 1 min; the core's backoff decides which failure is due).
- **Per-request interruption:** the `Medidor` has the `interrompido` flag, set by
  `mudou_rede(false)` (the system network callback, immediately, through `EclumeCore.rede`, also in
  the process opened only by the worker, and the 5-s read) and by `interromper_sync()` (the worker
  stopped by the system: cancelling the coroutine calls `EclumeCore.interromperSync`), and cleared
  by `preparar_sync` under the core's lock. With it set, the `Contador` returns `SyncInterrupted`
  (from `eclume-recorder`) without touching the network, the `Client` does not retry, and
  `sync_pending` returns the recording to `pending` without spending an attempt
  (`Queue::release_claim`) and ends the pass; the next Wi‑Fi resumes from the parts the server is
  missing. The desktop does not trigger the interruption.

## Recording session

- `gravar` opens the microphone (16 kHz mono through the mixer) and starts with the quality's bit
  rate (`padrao` 24 kbps, about 11 MB per hour; `alta` 48 kbps, about 22 MB per hour), with
  `source: mobile` and `ask_details`.
- **Pausar** discards samples without closing the microphone: reopening it in the background would
  run into Android 14+'s "while-in-use" restrictions. The **audio time** (without the pauses) is the
  screen's clock, the markers' `at_ms` and the upload's `duration_ms`.
- **Marcador** marks immediately, with a UUID `client_id`; the note comes later, optional
  (`anotar_marcador`). **Parar** closes the file and opens the "Gravação salva" sheet (title
  suggested from the start time, the agenda type chips and the **Idioma da transcrição**; Salvar or
  Pular). The language picker comes from the bridge (`idiomas`): "Padrão da conta: <idioma>" (empty
  value, the recording goes up with no language and the account's applies), "Detectar
  automaticamente" (`auto`), Português, Español and English; the account default is read from
  `GET /me/transcription` in the cycle that reads the agenda types and stays in the cache
  (`idioma_da_conta`) for the sheet off the network. `save_details` stores the language on the queue
  row, which the upload sends. `recorded_at` is the phone's clock at the start,
  `recorded_at_source: capture`.
- **Limits** (`estimativas.rs`): less than 1 h of recording in the free space gives the
  "Armazenamento quase cheio" notice on Início; less than 5 min, while recording, stops and saves on
  its own; battery at 15 % or less, discharging, gives the "Bateria em N %" banner, with the estimate
  only after 10 min of measured drain.
- **Process crash:** the `.ogg.part` already has the Ogg pages on disk; on the next open
  `session::recover` fixes it and the recording shows up as "Interrompida". The service destroyed
  with the recording in progress stops the recording through the bridge.
- **An unrequested stop gives notice:** `verificar_limites` returns the recording and the reason
  (`sem_espaco`, `fonte_encerrada`); the loop passes the reason and the saved time to
  `pararServico`, and the service posts "A gravação parou · <motivo> · <tempo> salvos" on the
  `avisos` channel before exiting (the same notice as `onDestroy` with a recording in progress).
- **Process watchdog:** on entering the foreground, the service stores "recording since" in the
  plugin's `SharedPreferences` and arms `setAndAllowWhileIdle` (`ELAPSED_REALTIME_WAKEUP`, 5 min;
  Doze stretches it to ~9 min). The `VigiaDaGravacao` (non-exported receiver) rearms while the
  service lives; in a new process, with the mark and no service, it posts "A gravação foi
  interrompida · Toque para abrir" and clears the mark. `encerrar` and `onDestroy` cancel the alarm
  and clear the mark. No `START_STICKY`: a background restart does not reopen the microphone on
  Android 14+.
- **A route change does not end it:** plugging or unplugging a headset with a microphone (3.5 mm,
  USB-C, Bluetooth) drops the stream, and the `MicSource` reconnects inside the source
  ([desktop-gravacao.md](desktop-gravacao.md) §Sources): the recording goes on in the same file, with
  silence in the middle. The reopening happens with the microphone service active in the foreground
  (the same process), which Android 14+ requires. The `EstadoSessao` carries `microfone` (`ok` or
  `reconectando`) and `silenciada`; the `eventos.rs` loop calls `Core::vigiar` every 250 ms, which
  marks "microphone lost" (a drop over 5 s, at the instant of the drop) and "microphone back", and
  redraws the notification when the microphone or the silencing change. The recording screen shows
  the "Microfone reconectando" or "Silenciado pelo sistema" banner.

## Native plugin and foreground service

The `tauri-plugin-eclume-gravador` plugin (`mobile/plugins/gravador`; runtime name
`eclume-gravador`, the same prefix as the permissions the `tauri-plugin` generates from the crate):

| Piece | What it does |
|---|---|
| `GravadorPlugin` | `microfone` and `notificacoes` permissions (the UI requests them before recording through `plugin:eclume-gravador\|request_permissions`); `iniciarServico` (answered by the service after `startForeground`, or rejected with the reason or by a 5-s deadline), `atualizarServico`, `pararServico(motivo?, duracaoMs?)`, `descobrir(segundos)`, `estadoDoDispositivo` (with `notificacoes` and `isencaoDeBateria`: `concedida`, `pedir` or `recusada`), `abrirConfiguracoesDoApp`, `pedirIsencaoDeBateria`, `abrirInstalador(caminho)`, `abrirUrl(url)`, `consumirAtalho` (`{gravar}`, `true` once per tap on the shortcut); on `load`, it follows the network, schedules the `SyncWorker` and reads the cold-start shortcut (`activity.intent`); on `onNewIntent`, the one of the app already open |
| `Atalho` | the `io.github.holetz.eclume.movel.GRAVAR_AGORA` action and the pure rule `ehGravarAgora(acao, flags)` (the action, without `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`), tested on the JVM by `AtalhoTest` |
| `ServicoDeGravacao` | `foregroundServiceType="microphone"`, started with the Activity visible (the tap on Gravar), `START_NOT_STICKY`, with `PARTIAL_WAKE_LOCK`; the notification's actions go to the core through `EclumeCore.acao`; on API 29+, `registerAudioRecordingCallback` while recording (removed on ending and in `onDestroy`): when `isClientSilenced()` changes, `EclumeCore.acao("silenciado" \| "audivel")`, which marks "silenced by the system". Below API 29 there is no signal |
| `Notificacao` | `gravacao` channel of low importance, no sound, public on the lock screen; "Gravando" with the system chronometer (`setWhen` = now − audio time) or "Pausado · 00:42:10"; "2 marcadores · espaço para cerca de 9 h", or "Microfone desconectado · reconectando", or "Silenciado pelo sistema"; Pausar/Continuar, Marcador and Parar |
| `EclumeCore` | `external fun acao`, `estado`, `syncPendentes` (with `interrompido`), `sondarPendentes`, `rede(wifiNaoMedido)` and `interromperSync`, implemented in `src-tauri/src/jni.rs` over the global core; they return JSON |
| `Descoberta` | `NsdManager` on `_eclume._tcp` (`registerServiceInfoCallback` on API 34+), raw TXT to the core, which interprets it through `discovery::parse` |
| `Conectividade`, `Dispositivo` | unmetered Wi‑Fi; battery, free space, `Build.MODEL` and the edge-to-edge insets in dp |
| `SyncWorker`, `Atualizador` | the WorkManager sync (`CoroutineWorker`, `dataSync` foreground through the `SystemForegroundService` with `foregroundServiceType="dataSync"` merged into the manifest, `agendarSync`); the system installer through the app's `FileProvider` (the APK stays in the cache) |

- Rust always calls the plugin **off the command's thread** (Kotlin answers on the caller's
  thread). `gravar` is `async`: on a blocking thread, it opens the recording and waits for
  `iniciarServico`; on refusal, it undoes the opened recording (queue and disk) and returns the
  reason to the screen.
- **Three core answers:** the service reads the bridge's JSON as a session, no session
  (`"sessao": null`) or error (`{"erro": …}`, `RespostaDoNucleo`). An error never ends it: it keeps
  the foreground and the last notification (on an `INICIAR`, it enters with the neutral
  notification). Only "no session" ends it, and Parar always ends it, even with an error, posting
  "A gravação parou com erro".
- **The JNI bridge does not abort:** the three `Java_…_EclumeCore_*` functions go through
  `responder` (`catch_unwind`), which returns `{"erro": "pânico: …"}`.
- **Channels:** `gravacao` (low importance, silent, the ongoing notification) and `avisos` (default
  importance, sounds: the recording stopped or was interrupted).
- **Battery exemption:** `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (the app is not shipped through
  Play, whose policy restricts it). Before the first Gravar with `isencaoDeBateria: pedir`, Início
  explains and offers to request it; Configurações show the state and offer to request it later.
- **"Gravar agora" shortcut** (the app's `res/xml/shortcuts.xml`, with `ic_atalho_gravar` and the
  `android.app.shortcuts` meta-data on the `MainActivity`, which is `singleTask`): a static shortcut
  with an intent to the `MainActivity` and the `GRAVAR_AGORA` action (an action, not an extra;
  `targetPackage` and `targetClass` written by hand, they follow the `applicationId`). The shortcut
  only opens the app: it never starts the service (the microphone one requires the Activity
  visible). The plugin stores the tap in an `AtomicBoolean` and swaps the Activity intent's action
  for `MAIN`, so recreation and recents do not fire again. The Quick Settings tile (`BlocoGravar`,
  `TileService`) is the second stage and is not in the app yet: it will open the Activity through
  the same action.
- **Manifest** (app and plugin): `RECORD_AUDIO`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_DATA_SYNC`, `POST_NOTIFICATIONS`, `WAKE_LOCK`,
  `ACCESS_NETWORK_STATE`,
  `INTERNET`, `REQUEST_INSTALL_PACKAGES`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `CAMERA` (for the
  QR reader) and `ACCESS_LOCAL_NETWORK`,
  declared ahead of `targetSdk 37`; `network_security_config` with no cleartext (the development
  server's HTTP only in `src/debug`); `FileProvider` with only the `cache-path`. `minSdk 26`,
  `targetSdk`/`compileSdk 36`.
- **Camera:** the official `tauri-plugin-barcode-scanner` (`windowed`, QR), with the permission in a
  phone-only capability (`capabilities/movel.json`, `platforms: android, iOS`). The text read is not
  trusted: `parse_pair_url` validates it before any network.

## Commands, event and UI

- **Tauri commands** (`comandos.rs`): `estado`, `descobrir`, `conectar_descoberto`,
  `conectar_endereco`, `confiar_ca`, `cancelar_ca`, `entrar`, `parear`, `gravar`, `pausar`,
  `continuar`, `marcar`, `anotar_marcador`, `parar`, `salvar`, `sincronizar_agora`, `gravacoes`,
  `gravacao` (with the stages on the server, cached off the network), `excluir_local`,
  `excluir_sincronizadas`, `tipos_de_agenda`, `configuracoes`, `salvar_configuracoes`, `sair`,
  `visibilidade`, `verificar_atualizacao`, `atualizar` and `abrir_na_web` (opens
  `endereco_na_web` through the plugin's `abrirUrl`).
- **Server title and "Abrir na web"** (holetz/eclume#118): the network cycle, at most every 60 s
  (`INTERVALO_DOS_TITULOS_MS`), reads `GET /recordings?since=` (`sync::buscar_titulos`, every page;
  the first from the oldest uploaded one still without a title, the following ones from the previous
  `since`, in memory) and stores each title in the v5 queue (`set_server_title`); opening the detail
  does the same with the `title` of `GET /recordings/{id}`. `GravacaoLocal.titulo_do_servidor` goes
  to the list and to the detail, which show the local title, else the server's, and only then "Sem
  título". `DetalheLocal.endereco_na_web` is `<servidor pareado>/gravacoes/<id no servidor>`; with
  it, the detail has **Abrir na web**, which opens the system browser (Intent `ACTION_VIEW`, like the
  installer) — the browser has to trust the server's root (article `certificado-do-servidor`).
- **`estado` event** (`eventos.rs`): the full `EstadoApp` (connection, network, session with
  `audio_ms`, level and markers, sheet, pending, notices, free space, version), on every change. The
  loop runs at 250 ms with the app visible (the meter needs it) and at 1 s invisible
  (`visibilidade`, through the UI's `visibilitychange`), when it only checks the limits and the
  microphone, with neither `estado()` nor `emit`; on becoming visible again, it emits on the first
  tick. The same loop closes the recording that hit a limit and tries the network cycle every 5 s.
  The device token stays in memory in the `Conexao` (read on open, replaced on sign-in, pairing,
  sign-out and credential loss): the state does not reread the disk.
- **Session before phase:** with a recording or the "Gravação salva" sheet in progress, the screen is
  the recording one, whatever the connection phase; with `sem_credencial`, it shows the "Entre de
  novo para sincronizar" banner without removing Pausar, Marcador and Parar.
- **Shortcut:** the App calls `consumirAtalho()` on mount and on every return to visibility.
  Consumed in the `conectado` phase, with no session or sheet, it goes to the `/` route and follows
  the same flow as the Gravar button (`app/gravar.ts`: permissions, the battery explanation,
  `gravar` and the error messages); with a session or sheet, nothing (the recording screen is
  already there); in another phase, it is discarded and the phase's screen explains what is
  missing. Each tap counts once.
- **Permissions:** a denied microphone shows "Abrir configurações do app"; blocked notifications
  become the "Notificações bloqueadas" banner on Início, with the same button.
- **UI** (`mobile/ui/src`): React + TS, a function of the `EstadoApp` (`app/estado.ts`), with the
  typed bridge (`ponte/`) and a fake bridge for the tests. The `eclume.css` is the DS copy generated
  from `design-system/styles.css` by `design-system/sincronizar.py` (the mobile `.m-*` layer),
  checked by `test_sincronizar.py` and against the web's by `ui/src/styles/copia.test.ts` (typed by
  `tsconfig.node.json`, because it reads the file from disk); product adjustments in `app.css`. No
  fixed `style` on the screens: spacing and sizes are `app.css` classes with `--space-*` and the DS
  sizes, and `style` only carries a custom property (the meter bars' `--h`); the
  `no-restricted-syntax` of `eslint.config.js` bars the rest. Theme through `data-theme` from
  `prefers-color-scheme`; insets in `--safe-top`/`--safe-bottom`; touch targets of 44 px or more.

| DS screen | Route | What it shows |
|---|---|---|
| Find server | `#/servidor` | "Encontre o seu servidor", the 10-s search, "Ler um código da web", "Digitar o endereço" |
| (Address) | `#/servidor/endereco` and the `confirmar_ca` phase | the address; the fingerprint with Confiar/Cancelar |
| Sign in | `sem_credencial` phase | "Entrar", the server, e-mail, password and the server's refusal |
| Scan a code | `#/ler-codigo` | the viewfinder over the camera and the web steps |
| Home, Away, Back on network, Low storage | `#/` | the network banner, Gravar, "Neste celular" and the storage notice |
| Recording, Paused, Low battery, Name and tag | session or sheet | the audio time, the meter, the markers, Pausar/Marcador/Parar, the battery banner and the sheet |
| Recording detail | `#/gravacao/<id>` | the local player (asset protocol only in `$APPDATA/eclume/gravacoes`), the markers, the stages on the server, "Excluir deste celular" |
| Settings | `#/configuracoes` | server, sync, quality, retention, usage, sign out, version and "Nova versão disponível" |

- **States and stages through the shared vocabulary.** `ui/src/app/vocabulario.js` (and `.d.ts`) is
  a byte-for-byte copy of `web/src/lib/vocabulario.js`, checked by `vocabulario.test.ts` (skipped
  without the web alongside). The list and detail badges are the on-device states, with the same
  name as the desktop (Gravando, Aguardando envio, Enviando, Enviada, Interrompida, Falhou o envio
  em perigo). The detail shows the seven stages in the server's order (agenda type before fields),
  each with its state in a word when not completed, and the "Motivos das etapas" list under the bar
  with the `reason` (text from `MOTIVOS`) of a skipped or waiting stage, or the `error.message` of
  one that failed. The Locutores stage in `waiting` (the account requires naming the speakers,
  holetz/eclume#144) shows "Locutores · aguardando você" with the reason; naming happens on the
  web. The core's `Etapa` (`sync.rs`) carries `reason` and `error` with `#[serde(default)]`, from
  the same read of `GET /recordings/{id}`.
- **The queue wait** (holetz/eclume#117): the same read carries `job.queue`; `buscar_etapas`
  returns `NoServidor { etapas, espera }`, the core keeps both in the detail cache and the
  `DetalheLocal` carries `espera`. Under the stages, the detail shows in `role="status"` the
  sentence from the vocabulary's `fraseDaEspera`, the same as the web and the desktop.
- **Deliberate difference from the DS:** the DS shows "AAC 64 kbps" and "58 MB por hora"; the app
  records Opus at 24 or 48 kbps (the format the server expects), and the texts show the real numbers.

## Tests and proof

- **Core** (`cargo test -p eclume-mobile-core`): the connection through the three paths, the
  network, the whole sync (with the Wi‑Fi dropping between parts and the resume), the probe and the
  worker's report, retention, the update and the session, with a scripted transport
  (`crates/core/tests/comum`) and a synthetic real-time source in place of the microphone.
- **Plugin** (`./gradlew testDebugUnitTest` in `gen/android`): the `success`/`retry` decision and
  the `SyncWorker`'s foreground, the notification and notice texts, the three core answers
  (`RespostaDoNucleo`, with the real `org.json` only in the tests), the actions, the Wi‑Fi rule, the
  battery and the exemption, the TXT and the `FileProvider` authority.
- **App** (`cargo test -p eclume-mobile`): `responder` turns error and panic into JSON, and the
  loop interval by visibility.
- **UI** (`npm --prefix mobile test`): the screens through the fake bridge.
- **Proof on the emulator** (`mobile/scripts/prova-emulador.sh` + `mobile/e2e/prova.mjs`): the
  `eclume-35` AVD headless with KVM (`-gpu swiftshader_indirect -no-snapshot`, microphone muted by
  `QEMU_AUDIO_DRV=none`), the x86_64 debug APK with the permissions granted, the WebView through
  Playwright `_android`, the lock screen and the network through `adb` and the notification through
  `uiautomator`. Against production, with the smoke account (`/srv/eclume/secrets/smoke-password`):
  it signs in through the address checking the fingerprint against `/server`, records, marks through
  the screen and through the notification, stays 60 s with the screen locked and in **forced Doze**
  (`dumpsys battery unplug`, `dumpsys deviceidle force-idle`, then `unforce` and `reset`) with the
  microphone service in the foreground and the audio time running, leaves the network (and waits for
  the app to notice, because the emulator still reaches the server over mobile data), stops and
  gives a title, and comes back to the network **with the app killed** (Home, `am kill`, Wi‑Fi on,
  the `SyncWorker` job id through `dumpsys jobscheduler` and `cmd jobscheduler run -f`) until the
  recording shows up on the server without opening the app (`source: mobile`, two markers); finally,
  recovery after `am force-stop` (the recording stays saved, `interrompida` or already
  `sincronizada`). It starts with Wi‑Fi on, which the AVD keeps from a proof that died midway. The
  cleanup erases the proof's recordings and revokes the device token.
- **Gate `android` pillar** ([monorepo.md](monorepo.md)): the minified release APK with a throwaway
  key, the plugin's and the app's `testDebugUnitTest` and `lintRelease`, and the JNI bridge checked
  by `mobile/scripts/simbolos_jni.py` in the `.so` and in the dex.
- **Release APK smoke** (`prova-emulador.sh --fumaca <apk x86_64>`, in `release-movel.sh`): opens,
  forces the `SyncWorker` job and requires the sync log, with no `UnsatisfiedLinkError`,
  `ClassNotFoundException` or `FATAL EXCEPTION` ([mobile-distribuicao.md](mobile-distribuicao.md)).
- **Audio:** the emulator microphone delivers silence; capturing a known sound through
  `-allow-host-audio` with a PulseAudio virtual source is a pending experiment, and until then the
  audio content is a human step on the device.
- **Real device:** the phone, with USB debugging on, goes into a USB port on the host (data cable,
  MTP mode). The proof's debug APK only carries `x86_64`; for the device, build
  `npm --prefix mobile run tauri -- android build --debug --apk --target aarch64` on the host and
  install it with `adb -s <serial> install -r` (keeps the data). That APK is signed with the debug
  key: the release one does not install over it, and switching requires uninstalling, which erases
  the recordings not yet uploaded. The 2026-09-29 acceptance (Galaxy M34, Android 16) went through
  mDNS, sign-in, recording with the screen locked and sync on returning to the Wi‑Fi.
- **Human steps:** acceptance on every new device, above all from makers with aggressive battery
  saving, and everything on iOS.
