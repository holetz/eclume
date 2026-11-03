---
type: standard
title: Mobile app distribution
description: How the eclume mobile app becomes an APK and updates itself — version in tauri.conf.json, tag mobile-v<version>, release on the host through deploy/release-mobile.sh (container with the read-only keystore, signed universal APK, certificate checked against mobile/certificado-release.sha256, smoke of the minified APK on the emulator), keystore only on the host, movel.json and SHA256SUMS, publishing to /srv/eclume/downloads/movel through deploy/publish-mobile.sh, which refuses an undeclared certificate change, and the in-app update through the pinned CA.
resource: mobile/src-tauri/tauri.conf.json, mobile/src-tauri/gen/android/app/build.gradle.kts, mobile/scripts/manifesto_movel.py, mobile/scripts/criar-keystore.sh, mobile/scripts/simbolos_jni.py, mobile/scripts/prova-emulador.sh, mobile/build.Dockerfile, mobile/INSTALACAO.md, deploy/release-mobile.sh, deploy/publish-mobile.sh
tags: [code, mobile, android, release, apk, host]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#41, holetz/eclume#89, holetz/eclume#90, holetz/eclume#91, holetz/eclume#108, holetz/eclume#128
maintainer: holetz
---

# Mobile app distribution

The mobile app ([mobile-app.md](mobile-app.md)) ships as a **signed APK**, downloaded from the
eclume server itself. There is no store: publishing on Google Play or the App Store is the product
owner's decision and account. iOS is out of scope, with no open spec.

## Version and tag

- The version lives in `mobile/src-tauri/tauri.conf.json` (`version`) and in the
  `[workspace.package]` of `mobile/Cargo.toml`, which move together. Android's `versionCode` comes
  from the version through Tauri.
- The tag is `mobile-v<versão>`. The bump belongs to the conclude of the spec that changes the app,
  never to a task, through `deploy/version.py set mobile <versão>` with its section in
  `mobile/CHANGELOG.md` ([versionamento.md](versionamento.md)).

## Release on the host — `deploy/release-mobile.sh`

Mirror of `release-desktop.sh` ([desktop-distribuicao.md](desktop-distribuicao.md)), with no GitHub
Actions: the keystore **never** goes to the GitHub secrets.

- It runs **on the workstation** and operates the host through the Docker context (`gpu-host`) and
  over SSH. `--plan` only shows version, tag, commit, expected certificate, disk and the blockers.
- With `--publish`, it refuses a dirty tree, a commit GitHub does not have, a commit without the
  host gate's `eclume/gate` = `success` status ([monorepo.md](monorepo.md); the waiver is
  `--skip-gate "<motivo>"`, with the `eclume/gate-dispensa` trail), a tag that already exists and the
  absence of `mobile/certificado-release.sha256` or of the keystore on the host. It refuses to start
  with the host disk at 90% or more, and the `~/eclume-build/movel/.trava` lock prevents two
  releases at the same time.
- The code goes **from the commit** (`git archive`) to `~/eclume-build/movel/src`. The container is
  `eclume-mobile-build:<versão do Rust>` (from `mobile/build.Dockerfile`, over the desktop build
  image: Ubuntu 24.04, Node, the pinned Rust with the Android targets and Python), with `--cpus 2`,
  uid 1000, the SDK, NDK and JDK from `mobile/scripts/android-sdk.sh` read-only and the Gradle cache
  on the host. `npm ci --ignore-scripts` runs without the keystore; only the build receives it,
  **read-only**, and writes the `keystore.properties` inside the container (erased at the end).
- Out come the **universal APK** (`aarch64`, `armv7`, minified by R8) and an `x86_64` APK with the
  same key, only for the smoke. `apksigner verify --print-certs` gives the certificate's SHA-256,
  which must match `mobile/certificado-release.sha256` (the versioned, public value: it already ships
  in `movel.json`); if it differs, the release stops.
- `mobile/scripts/manifesto_movel.py` writes `movel.json` and `SHA256SUMS`, checked before
  publishing.
- **Smoke of the minified APK:** `mobile/scripts/prova-emulador.sh --fumaca <apk x86_64>` starts the
  host's AVD, installs, opens the Activity, waits for the core's log, forces the `SyncWorker` job
  (`cmd jobscheduler run -f`) and requires the sync log, with no `UnsatisfiedLinkError`,
  `ClassNotFoundException` or `FATAL EXCEPTION` in logcat. Playwright does not open the WebView of a
  release APK; the smoke proves R8 and the JNI bridge through the path that does not depend on it.
  `--publish` always runs it.
- With `--publish`, the GitHub Release (private, like the repo) `mobile-v<versão>` with the APK,
  `movel.json`, `INSTALACAO.md` and `SHA256SUMS`, through the host's `gh`.

The release APK is also proved on every gate, in the `android` pillar ([monorepo.md](monorepo.md)):
minified and signed with a throwaway key, with the plugin's and the app's unit tests and lint and
the JNI symbol check (`mobile/scripts/simbolos_jni.py`: every `external fun` of `EclumeCore.kt` with
its `Java_…` symbol in the `.so`, and the class with the native methods in the dex).

## Keystore and certificate

- The keystore is created **once**, on the host, by
  `mobile/scripts/criar-keystore.sh --dname "<titular>"` (the holder comes from the app's identity,
  holetz/eclume#17): RSA 4096, 30-year validity, alias `eclume`, in
  `/srv/eclume/secrets/eclume-android.jks`, with the password in
  `/srv/eclume/secrets/android-keystore-password` (both 0600). The script refuses to overwrite an
  existing keystore and prints the certificate's SHA-256, to be versioned in
  `mobile/certificado-release.sha256`.
- **Losing it prevents updating the installed apps**: Android only installs over an APK signed with
  the same key, and the way out is to uninstall and pair again.
- **Backup**: the keystore and the password go, with the whole `/srv/eclume/secrets/` folder, into
  the encrypted restic snapshot of `deploy/backup.sh` (holetz/eclume#91), in the local repository and
  in the off-host copy; the nightly rehearsal checks the sha256 of the restored files, and a new host
  gets them back through `restore-backup.sh --new-host`
  ([deploy-producao.md](../../project/deploy-producao.md)). A GitHub secret is **not** a
  recoverable copy: it cannot be read back. The configured off-host copy
  (`secrets/restic-fora.env`, with the repository password kept outside it) is a precondition of the
  first release.
- Order of the first release: identity decided (#17) → keystore created with it → SHA-256
  versioned → off-host copy → green gate → `release-mobile.sh --publish` → `publish-mobile.sh`.
- The debug build (the emulator's and the proof's) uses the SDK debug key and is never published.

## `movel.json`

The manifest is a contract with the web's `/app-movel` page (holetz/eclume#38) and with the
installed app. Changing a field name requires changing both.

| Field | What |
|---|---|
| `versao` | the version (`0.1.0`) |
| `publicado_em` | ISO 8601 in UTC (`2026-09-27T18:30:05Z`) |
| `notas` | the release text, which the app shows in "Nova versão disponível": the version's section in `mobile/CHANGELOG.md` (`deploy/version.py notas movel <versão>`), unless `--notes` is explicit; a version with no section refuses the release |
| `apk.arquivo` | `eclume-<versão>.apk` |
| `apk.url` | absolute path on the server, `/downloads/movel/<versão>/eclume-<versão>.apk`: works for any server address |
| `apk.tamanho` | bytes |
| `apk.sha256` | SHA-256 of the APK, in lowercase hex |
| `min_android` | `8.0` (minSdk 26) |
| `certificado_sha256` | SHA-256 of the signing certificate, from `apksigner` |
| `instalacao` | `/downloads/movel/INSTALACAO.md` |

The script refuses a folder without exactly one `eclume-<versão>.apk` APK, without
`INSTALACAO.md`, with a version outside `X.Y.Z` or with a certificate that is not a SHA-256.

## Publishing on the host

`deploy/publish-mobile.sh [mobile-v<versão>]`, mirror of `publish-desktop.sh`, runs on the host
(where `gh` is authenticated; from the dev machine, `ssh holetz@192.168.15.199 'bash -s -- mobile-v0.1.0' <
deploy/publish-mobile.sh`):

- downloads the release to `/srv/eclume/downloads/movel/<versão>/` and checks `SHA256SUMS` before
  any swap;
- swaps `/srv/eclume/downloads/movel.json` and `/srv/eclume/downloads/movel/INSTALACAO.md` by copy
  and `mv` (never a half-written file), only if the version is not older than the published one
  (`FORCAR=1` points to an earlier one);
- keeps the three most recent versions, and never erases the one `movel.json` points to.
- refuses a release whose `certificado_sha256` differs from the already published `movel.json`: the
  installed apps would not update. The change only passes when declared, with
  `TROCAR_CERTIFICADO="<motivo>"` (the #17 case), which shows up in the log.

The eclume Caddy serves `/downloads/` ([deploy-producao.md](../../project/deploy-producao.md)).

## Installation and update

- **Installation:** the phone's browser does not trust the eclume internal CA. `INSTALACAO.md`
  explains installing `eclume-root.crt` as a user certificate or accepting the warning once, and
  checking the APK's SHA-256. The app does not depend on it: it pins the CA on its own.
- **In-app update:** on the eclume network, once a day, the core reads `movel.json` through the
  pinned CA. With a higher version, Configurações shows "Nova versão disponível · v<versão>".
  "Atualizar" downloads the APK through the pinned CA to the app's cache, checks `apk.sha256` and
  opens the system installer (`FileProvider`, `REQUEST_INSTALL_PACKAGES`); without the permission to
  install from unknown sources, it first opens the system screen that grants it. Android asks for
  confirmation and installs over it, keeping the recordings and the pairing.
