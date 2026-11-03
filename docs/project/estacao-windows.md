---
type: project
title: Windows development and test station
description: How to prepare a Windows machine to operate the GPU host and test the eclume desktop app — SSH key, the gpu-host Docker context, remote-run without rsync, installing and signing into the app without a PAT, debugging and capturing the window over the WebView2 CDP (cdp.mjs), the voice-note proof, the app log and cross-building Windows binaries on the host with cargo xwin.
resource: desktop/**, deploy/**
tags: [windows, station, desktop, runbook, cross-build]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#28, holetz/eclume#34, holetz/eclume#40
maintainer: holetz
---

# Windows development and test station

The Windows station operates the host `192.168.15.199` ([host-setup.md](host-setup.md)) and tests the
really installed desktop app. It **has neither Rust nor MSVC**: cargo, npm and the images run on the
host. The commands below run in Git Bash, unless indicated.

## 1. SSH and the Docker context

```bash
ssh-keygen -t ed25519 -N "" -C "<estacao>" -f ~/.ssh/id_ed25519
cat >> ~/.ssh/config <<'EOF'
Host gpu-host 192.168.15.199
  HostName 192.168.15.199
  User holetz
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 30
EOF
docker context create gpu-host --docker "host=ssh://holetz@192.168.15.199"
```

Authorizing the key asks for the `holetz` password, just once. In PowerShell, because Windows has no
`ssh-copy-id`:

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh holetz@192.168.15.199 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

Check with `docker --context gpu-host ps --filter label=com.docker.compose.project=eclume`.

## 2. `remote-run` without rsync

Git Bash does not ship `rsync`. The station's version, in `~/.local/bin/remote-run`, packs the
directory with `tar` (without `.git`, `target/`, `node_modules/`, `.venv/` and `dist/`), extracts over
`~/build/<name>` on the host, which preserves those caches, and runs the command with `nice`:

```bash
#!/usr/bin/env bash
set -euo pipefail
dir="${1:?uso: remote-run <dir> '<comando>'}"; cmd="${2:?}"; host="${REMOTE_RUN_HOST:-gpu-host}"
abs="$(cd "$dir" && pwd)"; name="$(basename "$abs")"
tar -C "$abs" --exclude=.git --exclude=target --exclude=node_modules --exclude=.venv --exclude=dist \
  -czf - . | ssh "$host" "mkdir -p ~/build/$name && tar -xzf - -C ~/build/$name"
ssh "$host" "export PATH=\$HOME/.cargo/bin:\$HOME/.local/bin:\$PATH; cd ~/build/$name && nice -n 10 bash -lc $(printf '%q' "$cmd")"
```

A file deleted on the station stays in the host copy until an explicit `rm`. Files generated
there (a `Cargo.lock`, a `cargo fmt`) come back through `scp gpu-host:build/<name>/<file> <local>`.
Examples: `remote-run desktop 'cargo test --workspace'`, `remote-run . 'uv run pytest server/tests'`.

The host copy has no `.git`: a `git diff` inside `remote-run` exits with 129. Checks that
depend on git, such as the generated client check (`npm --prefix web run gen:api` followed by
`git diff --exit-code web/src/api/schema.gen.ts`), run on the station. The web tests (Vitest with
jsdom) also run on the host: on the station some 1 s `findBy` calls time out because of jsdom
slowness on Windows, which is not a regression.

## 3. Installed app: signing in and the log

- **Install.** Download the NSIS from `https://192.168.15.199:8443/downloads/` (`instaladores.json`
  says which one) and run `eclume_<version>_x64-setup.exe /S`, which installs silently, per user, in
  `%LOCALAPPDATA%\eclume`. Config, queue and recordings live in
  `%APPDATA%\io.github.holetz.eclume`. Windows' `curl.exe` requires `-k` (or the CA in the
  system) and `--ssl-no-revoke`, because the internal CA does not publish a CRL.
- **Signing in, with no PAT and no CA in the system (0.2.0+).** The installer from `/downloads` carries the server address
  and the root CA fingerprint embedded: the first run shows "eclume em
  192.168.15.199 · Veio com este instalador", downloads `eclume-root.crt`, checks the fingerprint
  and stores it in `%APPDATA%\io.github.holetz.eclume\servidor-ca.pem`. All that is needed is the account's e-mail and
  password (or the pairing code from the web, under "Avançado"). The device credential
  is kept in the Credential Manager (target `pat.eclume-desktop`, the same as the old PAT).
  ([desktop-deteccao-e-sync.md](../standards/code/desktop-deteccao-e-sync.md#account-and-credential)).
- **Versions 0.1.x** required the CA in the system (`certutil -addstore -f Root eclume-root.crt`, as
  administrator) or the extra CA in the settings, and a pasted PAT. Whoever upgrades from one of them
  keeps the PAT and can switch to the account in Configurações · Servidor.
- **Log.** `%LOCALAPPDATA%\io.github.holetz.eclume\logs\eclume.log`
  ([desktop-gravacao.md](../standards/code/desktop-gravacao.md#app-and-tray)).

## 4. Driving the app without clicking

WebView2 opens the debugging port when the variable is in the environment of whoever launches the app:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9229"
Start-Process "$env:LOCALAPPDATA\eclume\eclume-desktop.exe"
```

`http://127.0.0.1:9229/json` lists the window. `desktop/scripts/cdp.mjs` (Node 22, no
dependency) evaluates in the window with `awaitPromise` and captures what it shows:

```bash
node desktop/scripts/cdp.mjs eval "window.__TAURI__.core.invoke('status')"
node desktop/scripts/cdp.mjs eval "document.querySelector('[data-vista]:not([hidden])').dataset.vista"
node desktop/scripts/cdp.mjs screenshot janela.png
```

The expression calls the same commands as the window: `'status'`, `'recordings'`,
`'toggle_recording'`, `'new_note'`, `'add_marker'`, `'save_settings'`, `'answer_meeting'`,
`'sync_now'`, and on the first run `'discover_servers'`, `'prepare_server'` and `'sign_in'`.
`CDP_PORT` changes the port. To get system audio in a test recording, play a WAV with
`(New-Object System.Media.SoundPlayer x.wav).PlaySync()`. Detection ignores any
executable whose **name** contains "eclume": run the meeting simulator under another name.

## 5. Voice-note proof

`powershell -NoProfile -File desktop/scripts/prova-windows.ps1` runs the end-to-end proof on this
station: it downloads and installs the NSIS from `/downloads`, opens the app with port 9229, captures the first
run (with the embedded server), signs in with the test account (`ECLUME_PROOF_EMAIL` and
`ECLUME_PROOF_PASSWORD`), records a note through the `Ctrl+Alt+N` shortcut speaking a text through the Windows
voice on the speakers, and checks through the API (`desktop/scripts/prova_nota.py`) that the note reached the
library with `kind=note`, `eclume-desktop/<version>` and `transcribed`. The note only stops by itself
with voice on the microphone: with a muted microphone, it is discarded ("não ouvimos voz") and the proof stays
pending for a person to speak. The synthesized shortcut (`keybd_event`) only reaches the app with the session
**unlocked**: with the screen locked, the input goes to the logon screen and the shortcut does not fire.
The proof swaps the installed app's credential for the test account's; after it, "Sair" and sign in
again with the everyday account.

## 6. Windows binaries cross-built on the host

To diagnose capture (WASAPI) without MSVC on the station, build on the host for
`x86_64-pc-windows-msvc` with `cargo xwin` and bring back the `.exe`:

```bash
remote-run desktop 'cargo xwin build --release --target x86_64-pc-windows-msvc -p eclume-desktop --example gravar'
scp gpu-host:build/desktop/target/x86_64-pc-windows-msvc/release/examples/gravar.exe .
./gravar.exe 12 ./saida    # records 12 s of mic + system and prints the .ogg
```

A `target/` seeded from another folder on the host (`~/build/desktop`, for example) keeps the old path
in the build scripts: when a new Tauri plugin enters, the build fails reading
`~/build/desktop/target/.../permissions`. Fix it with `cargo clean -p tauri` (and the same with
`--target x86_64-pc-windows-msvc`).

The host has the toolchain installed in `holetz`'s space, without apt: the `x86_64-pc-windows-msvc` target
(`rustup target add`), `cargo-xwin` (`cargo install --locked cargo-xwin`), `ninja` and
`cmake` through `uv tool`, and links in `~/.local/bin`: `clang-cl` → `clang-18`, `lld-link` → the
toolchain's `rust-lld`, `llvm-rc` → `llvm-rc-18`, `llvm-mt` → `llvm-mt-18` and `llvm-lib` →
`llvm-lib-18`. The first build downloads Microsoft's CRT and SDK to `~/.cache/cargo-xwin`.
The official installers come out of `deploy/release-desktop.sh`, which builds the NSIS with the same
`cargo-xwin` in a container (Windows is the default; `--no-windows` omits it), or from `desktop-release`
([desktop-distribuicao.md](../standards/code/desktop-distribuicao.md)).

## Validation of 2026-09-25 (holetz/eclume#28)

Windows 11, Realtek and an Intel Smart Sound microphone array, with 0.1.1 published. These worked:
silent install, PAT in the keychain, sync, detection of an app on the mic with the prompt, automatic
recording that stops 15 s after the mic is released, and the updater from 0.1.0 to 0.1.1 with the app
reopened. The system audio reached the server muted because of a defect in the mixing debt, already
fixed. This machine's microphone array delivers digital silence, and that is the driver's doing.

After the fix (0.1.2, published by `desktop-release`), the updater took the app from 0.1.1 to
0.1.2 and reopened it. A 35 s manual recording with `two-voices.ogg` playing on the speakers came out
at 86 KB (before, 18 KB muted) and reached the server transcribed with 13 segments and 2 speakers, the
same result as the fixture uploaded directly. `eclume.log` recorded the opening, the recording and the sync.
