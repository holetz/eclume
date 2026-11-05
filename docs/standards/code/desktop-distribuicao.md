---
type: standard
title: Desktop app distribution
description: How the eclume desktop app becomes installers and updates itself — version in tauri.conf.json, tag desktop-v<versão>, release on the host through deploy/release-desktop.sh (Linux; Windows optional by cross-compilation; macOS out while the repository is private) and the desktop-release workflow as the manual alternative, the server address and fingerprint embedded in the build, updater packages signed with the project's own minisign key, latest.json and instaladores.json with eclume server URLs, publication to /srv/eclume/downloads through deploy/publish-desktop.sh and the "Atualizado para X" notice.
resource: desktop/scripts/sign-windows.sh, desktop/src-tauri/tauri.conf.json, desktop/src-tauri/build.rs, desktop/src-tauri/icons/**, desktop/src-tauri/Info.plist, desktop/src-tauri/src/updater.rs, desktop/src-tauri/src/config.rs, desktop/scripts/release_manifests.py, desktop/scripts/tray_icons.py, desktop/INSTALACAO.md, desktop/build.Dockerfile, desktop/build-windows.Dockerfile, .github/workflows/desktop-release.yml, .github/workflows/desktop-platforms.yml, deploy/release-desktop.sh, deploy/publish-desktop.sh
tags: [code, desktop, release, updater, tauri, ci, instaladores]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#16, holetz/eclume#26, holetz/eclume#40, holetz/eclume#57, holetz/eclume#60, holetz/eclume#88, holetz/eclume#89, holetz/eclume#90, holetz/eclume#109, holetz/eclume#126, holetz/eclume#102, holetz/eclume#101, holetz/eclume#128
maintainer: holetz
---

# Desktop app distribution

The desktop app ships as installers that update themselves through the Tauri updater, whose
package is signed with the project's **own minisign key**. The Windows installer ships with an
**Authenticode code signature** (with a timestamp) whenever the host has the vendor configuration
(§Windows code signing); without it, it ships unsigned, and publishing it that way requires
`--unsigned`. Linux has no code signing. Because the repository is private, clients never download from GitHub:
they download from the eclume server itself, at `https://<servidor>:8443/downloads/` (the
release's `ECLUME_DOWNLOADS_URL`).

While the repository is private, GitHub Actions minutes have a quota, and the release ships **from
the host**, without Actions. Platforms:

| Platform | State |
|---|---|
| Linux | ships in every release (AppImage and deb) |
| Windows | ships in every release (NSIS), Authenticode-signed when the host has the configuration; `--no-windows` on the host or `windows: false` in the workflow leave it out |
| macOS | **out** until the repository goes public (a macOS minute costs 10×) |

A platform left out of the release disappears from `latest.json`, and its clients stay on the
version they have.

```
deploy/release-desktop.sh (na estação) ──► host: contêiner --cpus 2 ──► GitHub Release (privado)
   git archive do commit                   │ build Linux (+ Windows)          │ desktop-v<versão>
                                           │ assina com a chave do host (.sig) │ gh release download
                                           └ latest.json, instaladores.json,   ▼
                                             SHA256SUMS      deploy/publish-desktop.sh (no host)
                                                                               │
                                   /srv/eclume/downloads/ ◄────────────────────┘ ──► Caddy /downloads/
```

## Version and tag

- The published version is the `version` field of `desktop/src-tauri/tauri.conf.json`. The
  `version` of the cargo workspace (`desktop/Cargo.toml`) follows by convention, but the release
  does not read it.
- The tag is `desktop-v<versão>`, created by the release itself (`gh release create --target <commit>`),
  never by hand: it triggers no workflow.
- When the version goes up and who raises it (the conclude of the spec that changes the app, through
  `deploy/version.py set desktop <versão>`, with its section in `desktop/CHANGELOG.md`) is in
  [versionamento.md](versionamento.md).
- Releasing a version: with the version and its section on `main`, push `main`, wait for the host
  gate (`eclume/gate` = `success` on the commit; [monorepo.md](monorepo.md)) and run
  `bash deploy/release-desktop.sh --context <contexto> --publish`.

## Release on the host — `deploy/release-desktop.sh`

- It runs **on the workstation** and operates the host through the Docker context and SSH, like
  `deploy/deploy.sh`. The context has no default (`--context` or `ECLUME_DOCKER_CONTEXT`), and without `ECLUME_DOWNLOADS_URL` (from the environment or the
  repository variable) the script refuses: a default would publish the updater pointing at someone
  else's server. `--plan` only shows version, tag, commit, targets, folders, disk and the
  blockers, without writing.
- The code comes **from the commit**, not from the working tree: `git archive HEAD` goes to
  `~/eclume-build/release/src` on the host, recreated on every release. With `--publish`, the
  script refuses a dirty tree, a commit GitHub does not have, a commit without the `eclume/gate` =
  `success` status (the host gate) and a tag that already exists. Waiving the gate is explicit and
  per invocation: `--skip-gate "<motivo>"` waives only the status and publishes on the commit the
  trail `eclume/gate-dispensa` = `failure` with the reason; a clean tree and a commit on GitHub are
  still required. Without `--publish` it is a **dry run**: the artifacts stay in
  `~/eclume-build/release/dist-<versão>/` on the host and nothing is published.
- **Compile without secrets, bundle with them.** Each target runs in two containers: `tauri build
  --no-bundle` with no secret mounted (that is where the build scripts of third-party crates run)
  and `tauri bundle` with the updater key and, for a signed Windows build, the signing
  configuration at `/run/assinatura` (read-only) and `--config` with the `bundle.windows.signCommand`.
  `tauri.conf.json` has no `signCommand`: local and Actions builds do not try to sign.
- **Check before publishing:** with a signature, the release checks the setup and, extracted by
  `7z`, the `eclume-desktop.exe` and the `uninstall.exe` (`sign-windows.sh --verify`); any
  failure stops the release. Without configuration, the dry run warns "instalador Windows sem
  assinatura", `--plan` shows `assinatura Windows ausente`, and `--publish` refuses without
  `--unsigned`.
- The build image comes from `desktop/build.Dockerfile` with the minimal context (only
  `desktop/rust-toolchain.toml`): Ubuntu 24.04 and Node by digest, the Rust from the file, and the
  tag `eclume-desktop-build:<versão do Rust>` (the Windows one likewise, with a pinned-version
  `cargo-xwin`). The Tauri CLI comes from `desktop/package-lock.json`: a container **without the
  updater key** runs `npm ci --ignore-scripts`, and only then does the build, with the key, run
  `npx --no-install tauri`.
- The build runs in that image's container with
  `--cpus 2`, `CARGO_BUILD_JOBS=2` and `nice`, as uid 1000; `target/` (`target-linux`,
  `target-windows`) and the cargo registry (`~/eclume-build/cargo-registry`) persist on the host
  so the following builds are incremental. The script refuses to start with the host disk at
  `ECLUME_DISK_LIMIT` (90%) or more, and a lock (`~/eclume-build/release/.trava`) prevents two
  releases at the same time.
- **Windows** (default; `--no-windows` omits it): cross-compilation in the container of `desktop/build-windows.Dockerfile`
  (`nsis`, `lld`/`llvm` 18, the `x86_64-pc-windows-msvc` target and `cargo-xwin`), with
  `tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis`. Only the NSIS
  ships: the MSI requires WiX, which only runs on Windows. The image and the cross-compiled libopus
  were proven in the dry run of holetz/eclume#68 (the NSIS came out of the host).
- The manifests are produced on the host, by `release_manifests.py` (with `desktop/INSTALACAO.md`
  copied), and `SHA256SUMS` is checked before publishing. `--publish` creates the GitHub Release
  through the host's `gh`. The `notes` of `latest.json`, which is the text of the "Atualizado para
  X" notice, is the version's section in `desktop/CHANGELOG.md`
  (`python3 deploy/version.py notas desktop <versão>`); an explicit `--notes` wins, and a version
  without a section refuses the release. The `desktop-release` workflow does the same with the
  `notas` input empty.

## Workflow `desktop-release.yml` — the alternative

- It triggers **only** on `workflow_dispatch`: the tag the host release creates does not trigger
  it. It makes the same release on GitHub Actions — Linux always; Windows (`nsis,msi`, on
  `windows-2025`) with the `windows` input, on by default (the minute costs 2×; uncheck it for
  Linux only). `publish: false` (default) is a dry run — the artifacts stay in the run. To
  publish, the `plan` job checks `eclume/gate` = `success` on the commit (permission
  `statuses: read`, `deploy/gate.py decide`) and fails without it; there is no waiver here —
  whoever needs to waive publishes from the host.
- The Tauri CLI is the one from `desktop/package-lock.json` (exact version, the same as mobile),
  installed by `npm --prefix desktop ci --ignore-scripts` in a step without the secrets and run by
  `npx --no-install tauri build --ci --bundles <lista>`, without `tauri-action`: its `latest.json`
  would point at private GitHub URLs.
- The Windows-only code compiles and passes `clippy -D warnings` on every host gate, by
  cross-compilation (`windows` pillar). The proof of **execution** on a real Windows stays manual:
  `desktop-platforms.yml` (by hand) runs the workspace `cargo check` and the tests of
  `eclume-mirror` and `eclume-sync` on `windows-2025`.

## Server embedded in the installer

- The release is per server (the manifests already carry absolute URLs of this host), so the build
  embeds the address and the fingerprint of the root CA: the build receives `ECLUME_SERVER_URL` and
  `ECLUME_SERVER_CA_SHA256` from the **repository variables** (written by holetz/eclume#35, next to
  `ECLUME_DOWNLOADS_URL`); `release-desktop.sh` reads them through `gh variable get` and accepts an
  override from the environment.
- **At the root rollover** (holetz/eclume#101), `ECLUME_SERVER_CA_SHA256` changes to the
  fingerprint of the project's own root and requires a desktop release right after: the installers
  in `/downloads` embed the old fingerprint and, on a new installation, the first run would refuse
  the served root. Apps already installed cross the rollover on their own through the next stored
  root ([desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md)).
- The app reads them through `option_env!` (`config::embedded_server`), with
  `cargo:rerun-if-env-changed` in `build.rs`. An empty variable or an invalid address embeds
  nothing; a local build, without them, has no embedded server.
- The first run shows the embedded one as "Veio com este instalador" and pins the CA by its
  fingerprint, without the person typing an address
  ([desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md)). The default `web_url` of a new
  config is the embedded one. A build without an embedded server **starts without a server**
  (`web_url` empty): there is no default address, the commands that need the server answer
  "servidor não configurado" and the sync uploads nothing until the first run picks one (found by
  mDNS or typed). An old `config.json` without `web_url` gets the build's default — the embedded
  one, in every published installer.

| Platform | Where it compiles | Output |
|---|---|---|
| Linux | Ubuntu 24.04 (the `libspa` of the `pipewire` crate does not compile with the PipeWire 0.3.48 of 22.04; the AppImage requires glibc 2.39+) | `eclume_<v>_amd64.AppImage` and `eclume_<v>_amd64.deb`, with `.sig` |
| Windows (optional) | host: cross with `cargo-xwin`; Actions: `windows-latest` | `eclume_<v>_x64-setup.exe` (NSIS, per user, no admin), with `.sig`; the `eclume_<v>_x64_pt-BR.msi` (WiX) only through Actions |
| macOS (out) | `macos-latest`, `--target universal-apple-darwin`, when it comes back | `eclume_<v>_universal.dmg` and `eclume_<v>_universal.app.tar.gz` (+ `.sig`), a single one for Intel and Apple Silicon |

- The AppImage is generated with `APPIMAGE_EXTRACT_AND_RUN=1` (no FUSE in the container or the
  runner) and `NO_STRIP=true` (linuxdeploy's `strip` fails on binaries with `.relr.dyn`).

## Bundle

- `bundle.createUpdaterArtifacts: true` signs each package with `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (on the host, read from the copy in `/srv/eclume/secrets`;
  on Actions, from the secrets).
- The `.deb` declares the audio libs the binary links dynamically (`libasound2`,
  `libpulse0`, `libpipewire-0.3-0`, with the `t64` alternative of Ubuntu 24.04); TLS is rustls,
  without `libssl`.
- macOS: `minimumSystemVersion` 15.0 (the `cidre` of system capture compiles with `macos_15_0`),
  **ad hoc** signing (`signingIdentity: "-"`), no hardened runtime, and the `Info.plist` with
  `NSMicrophoneUsageDescription` and `NSAudioCaptureUsageDescription`, without which macOS denies
  the microphone and the process tap.
- The bundle icons are generated from `desktop/src-tauri/icons/icon.svg` by `tauri icon`, and only
  those `bundle.icon` lists are included.
- The tray ones, `tray-{idle,recording,note,syncing}.png` (64 × 64), come from the same mark through
  `uv run --with pillow python desktop/scripts/tray_icons.py`: the orange square with the five
  white bars; during a meeting the square takes the DS recording color, and the note and the upload
  gain a state dot. `tray.rs` swaps the icon only when the state changes — on Linux each swap
  writes a PNG and reloads the AppIndicator —, and never by the audio level. On GNOME, the
  AppIndicator extension sometimes reads the temporary PNG (`/run/user/<uid>/tray-icon/`) after
  `tray-icon` has already replaced it with the next one and logs "Failed to recognize image
  format": a race in the crate, whose only effect is that the icon of that swap does not appear.

## Manifests

`release_manifests.py` writes into the release folder, with absolute URLs
`<base>/<versão>/<arquivo>` (base in `ECLUME_DOWNLOADS_URL`, mandatory, no default):

- **`latest.json`** — the updater manifest: `version`, `notes`, `pub_date` and `platforms` with
  `url` and `signature` (contents of the `.sig`). Per-installer keys (`windows-x86_64-nsis`,
  `windows-x86_64-msi`, `linux-x86_64-appimage`, `linux-x86_64-deb`, `darwin-<arch>-app`) and the
  generic ones (`windows-x86_64` → NSIS, `linux-x86_64` → AppImage, `darwin-aarch64` and
  `darwin-x86_64` → the universal one). The updater looks up `<os>-<arch>-<instalador>` first.
- **`instaladores.json`** — what the download page consumes: `versao`, `publicado_em`,
  `notas`, `instalacao` (URL of `INSTALACAO.md`) and `instaladores[]` with `plataforma`,
  `arquitetura`, `tipo`, `arquivo`, `url`, `tamanho`, `sha256` and `recomendado` (NSIS, AppImage and
  DMG).
- **`SHA256SUMS`** — of every file, in the `sha256sum -c` format.

The names `latest.json`, `instaladores.json` and `INSTALACAO.md` at the root of `/downloads/` are a
contract with the download page and with the apps already installed: they do not change.

## Publication on the host

`deploy/publish-desktop.sh [desktop-v<versão>]` runs on the host (where `gh` is authenticated):
it downloads the release into a temporary folder inside `/srv/eclume/downloads`, checks
`SHA256SUMS` and the version of `latest.json`, moves it to `/srv/eclume/downloads/<versão>/` and
only then swaps `latest.json`, `instaladores.json` and `INSTALACAO.md` at the root (copy + `mv`,
atomic). It does not roll the root back to an older version without `FORCAR=1` and keeps the three
most recent versions. eclume's Caddy serves the folder at `/downloads/`.

## Start with the computer

The installer does not register starting with the computer: the app itself registers it through
`tauri-plugin-autostart` (`desktop-interface.md`, "Start with the computer"). On Windows it is the
`eclume` key in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (per user, no admin); on
Linux, a `.desktop` in `~/.config/autostart` (with `$APPIMAGE` when the app is an AppImage); on
macOS, a LaunchAgent. The registered command line carries `--autostart`. Because the app
reconciles the registration on every launch, an update that changes the executable's path fixes it
on the next launch.

## Updater in the app

- `desktop/src-tauri/src/updater.rs` checks `<web_url>/downloads/latest.json` 30 s after opening
  and every 6 h; the `web_url` is the one in the app's config, so changing the server address does
  not require a release. The `endpoints` of `tauri.conf.json` only exists because the plugin
  requires a value: it is neutral (`https://eclume.invalid/downloads/latest.json`) and `updater.rs`
  always replaces it with the one from `web_url`; with no server configured, there is no check.
- It only downloads and installs with the app **idle** (neither recording nor syncing) and only
  restarts if it stays idle. On Windows, the installer runs in `passive` mode and reopens the app.
  A debug build does not update itself.
- TLS follows the sync's trust (`AppState::trust`, which reads only the config; see
  [desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md)), applied through
  `UpdaterBuilder::configure_client` (holetz/eclume#102):
  - **CA pinned** by the first run: `tls_certs_only` with its single certificate, without the
    system roots. An unreadable pinned CA, or one with more than one certificate, makes the check
    **not run** (it goes to the log), without falling back to the system roots;
  - **CA chosen by hand** in Servidor · Avançado: `tls_certs_merge`, added to the system ones;
    unreadable, it only logs a warning and the check goes on with the system ones;
  - **no own CA**: the default client (rustls with `rustls-platform-verifier`), which sees the CA
    installed in the OS.

  The package is still checked by minisign; the pinned TLS protects `latest.json` and the download.
  No `dangerousAcceptInvalidCerts`.
- `configure_client` exposes the plugin's `reqwest`, which may change in a minor: the plugin is
  pinned at `2.12` and the app's `reqwest` is the same `0.13`, with no features of its own.
- **"Atualizado para X".** Before `update.install`, the updater writes to `config.json`
  `pending_update: {version, notes}` (the `body` of `latest.json`). On launch, if `last_version`
  differs from the current version and the `pending_update` is for this version, the window shows
  the `.alert-success` "Atualizado para 0.2.0" with the notes, and the notification "eclume
  atualizado para 0.2.0" goes out once. `dismiss_update_notice` clears the `pending_update`. On the
  first installation (no `last_version`), there is no notice.
- **End-to-end update proof** (Linux, on the host): the published 0.1.0 runs under Xvfb
  (`xvfb-run -a dbus-run-session -- ./eclume.AppImage`, with temporary `HOME`/`XDG_*` and
  `SSL_CERT_FILE` = system CAs + `eclume-root.crt`, because 0.1.0 only knows the system ones and
  `rustls-native-certs` honors the variable), queries the production `latest.json` at 30 s,
  downloads the new version's AppImage, checks the minisign signature, swaps the file and restarts.
  Done on 2026-09-25 with `desktop-v0.1.1` published: `versão 0.1.1 disponível` →
  `rewriting AppImage` → `versão 0.1.1 instalada` in ~1 s, the file took the SHA-256 of the 0.1.1
  AppImage and the app reopened on the new version.

## Windows code signing

- **Tool:** `jsign` (pinned version, sha256 checked in the build of the
  `eclume-desktop-build-windows` image, with headless Java), which signs on Linux through
  `--storetype`: `TRUSTEDSIGNING` (Azure Artifact Signing), `AZUREKEYVAULT`, the cloud HSMs of the
  commercial CAs, `PKCS11` (physical token) and `PKCS12` (test). Since 2023 the key of a public
  code-signing certificate lives in hardware, so a plain `.pfx` is not the normal case.
  `osslsigncode` verifies, and `7z` opens the installer. Tauri calls
  `desktop/scripts/sign-windows.sh %1` through `signCommand` for each executable **before**
  generating the updater artifacts: the minisign `.sig` of `latest.json` covers the already signed
  installer.
- **Configuration on the host**, like the updater key: `/srv/eclume/secrets/assinatura-windows/`
  (`chmod 600`, owned by uid 1000) with `assinatura.env` (`JSIGN_STORETYPE`, `JSIGN_KEYSTORE`,
  `JSIGN_ALIAS`, `JSIGN_CERTFILE` when the keystore does not carry the chain, `JSIGN_TSAURL`) and
  the password or the token: the `storepass` file or `JSIGN_STOREPASS_CMD`, a command that prints a
  short-lived token; plus whatever files the vendor asks for (relative paths are relative to the
  folder). The folder goes in read-only at `/run/assinatura` and never passes through the
  workstation. **Never** in the repository.
- **Always SHA-256 and with an RFC 3161 timestamp:** without `JSIGN_TSAURL`, or with the
  timestamp authority down, signing fails (`jsign` tries 3 times). The password reaches `jsign`
  through a temporary file, off the command line.
- **Switching vendors** is swapping `assinatura.env` (and its files) on the host, without changing
  the script or the release. A vendor that does not fit `jsign` becomes a new mode in the same
  script.
- `sign-windows.sh --self-test` signs and verifies an NSIS stub with a self-signed PKCS#12 and
  checks that an unsigned executable is refused.
- The `desktop-release.yml` workflow (the Actions alternative) remains **unsigned**.

## Updater key

- The private key and the password live in `/srv/eclume/secrets/tauri-updater.key` and
  `tauri-updater.key.password` on the host (`chmod 600`, owned by uid 1000) and in the workflow
  secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The host release
  mounts them **read-only** into the build container; they never pass through the workstation.
  **Never** in the repository.
- The public key lives in `plugins.updater.pubkey` of `tauri.conf.json`.
- Changing the key breaks automatic updates for every installed client: the version with the new
  key has to be installed by hand.
