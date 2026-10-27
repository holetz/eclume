# eclume desktop

eclume's Tauri 2 app: records meetings (mic + system audio) in Ogg/Opus mono 16 kHz, notices on
its own when a meeting starts (Teams, Zoom, Meet, with each app's policy), records voice notes that
stop on silence, marks moments during a recording, imports audio and video files, keeps the local
queue and uploads it to the server with resumable upload, and lives in the system tray. On the
first run, the person signs in with e-mail and password on the server embedded in the installer
(or found on the network through mDNS), with the CA pinned by its fingerprint.

The installers come out of the host, through `bash deploy/release-desktop.sh` (Linux and Windows;
Windows comes out unless `--sem-windows` is passed; macOS out while the repository is private), or
from the `desktop-release` workflow by hand, and the app updates itself through the Tauri updater;
the process is in
[docs/standards/code/desktop-distribuicao.md](../docs/standards/code/desktop-distribuicao.md) and
the step-by-step guide for the user, in [INSTALACAO.md](INSTALACAO.md).

| Path | What it is |
|---|---|
| `src-tauri/` | the app: tray, window, state, config and commands |
| `ui/` | the window in eclume's Design System (HTML and ES modules, no bundler) |
| `ui-tests/` | Playwright tests of the window with Tauri mocked, including the visual check |
| `crates/audio-capture/` | mic capture (`cpal`) and system audio capture (PipeWire/Pulse, WASAPI, Core Audio), adapted from Anarlog |
| `crates/recorder/` | mixing to 16 kHz, Ogg/Opus encoder, the note's silence detector, SQLite queue (v4, with markers), recording session and sync/detection traits |
| `crates/resampler/` | resampler vendored from Anarlog |
| `crates/detect/` | meeting detection: per-OS mic signals (adapted from Anarlog), classification, debounce and automatic recording |
| `crates/sync/` | sync: the v1 contract's resumable upload, login and device pairing, pinned CA, mDNS discovery and the credential in the OS keychain |
| `crates/import/` | import: the file's duration and date (`mvhd`, tags, modification time) and conversion to Opus through `symphonia` |
| `scripts/manifestos_release.py` | builds a release's `latest.json`, `instaladores.json` and `SHA256SUMS` |
| `scripts/sincronizar_ds.sh` | copies the Design System's `eclume.css` and fonts into `ui/` |
| `scripts/cdp.mjs` | `eval` and capture in the real window through WebView2's CDP |
| `scripts/prova-windows.ps1`, `scripts/prova_nota.py` | the voice-note proof on a Windows workstation |

The recording format, the voice note, the markers and the queue are in
[docs/standards/code/desktop-gravacao.md](../docs/standards/code/desktop-gravacao.md); detection,
policies, the account, sync and retention, in
[docs/standards/code/desktop-deteccao-e-sync.md](../docs/standards/code/desktop-deteccao-e-sync.md);
the window, in [desktop-interface.md](../docs/standards/code/desktop-interface.md); import, in
[desktop-importacao.md](../docs/standards/code/desktop-importacao.md); the layout, the commands and
the vendoring rule, in [docs/standards/code/monorepo.md](../docs/standards/code/monorepo.md).

On Linux, the build requires `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`,
`librsvg2-dev`, `libxdo-dev`, `libssl-dev`, `build-essential`, `libasound2-dev`,
`libpipewire-0.3-dev`, `libpulse-dev`, `clang` and `cmake`. Without them (or without sudo),
`build.Dockerfile` assembles the same environment as CI in a container; `cargo` and the Tauri CLI
run inside it, with the repository mounted. The desktop build is heavy: on a workstation that also
runs an IDE and a browser, limit the CPU (`--cpus 2`, `CARGO_BUILD_JOBS=2`) or run it on a
separate host.

```bash
docker build -t eclume-desktop-build -f desktop/build.Dockerfile desktop
docker run --rm --cpus 2 -e CARGO_BUILD_JOBS=2 -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/src" -w /src/desktop eclume-desktop-build \
  cargo test --workspace
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/src" -w /src/desktop \
  eclume-desktop-build npm ci --ignore-scripts
# the .deb, without the signed updater artifacts
docker run --rm --cpus 2 -e CARGO_BUILD_JOBS=2 -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/src" -w /src/desktop/src-tauri eclume-desktop-build \
  npx --no-install tauri build --bundles deb --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

```bash
cargo check --manifest-path desktop/Cargo.toml --workspace
cargo clippy --manifest-path desktop/Cargo.toml --workspace -- -D warnings
cargo test --manifest-path desktop/Cargo.toml --workspace
# real capture, no window: records 5 s of mic + system and prints the .ogg path
cargo run --manifest-path desktop/Cargo.toml -p eclume-desktop --example gravar -- 5 /tmp/eclume-gravar
# meeting signals, no window: prints for 10 s who uses the mic and the classification
cargo run --manifest-path desktop/Cargo.toml -p eclume-detect --example sinais -- 10
# sync against the contract mock (deploy/docker-compose.mock.yml on 127.0.0.1:4010)
ECLUME_MOCK_URL=http://127.0.0.1:4010 cargo test --manifest-path desktop/Cargo.toml -p eclume-sync --test mock
# the window in Chromium, with Tauri mocked (captures in ui-tests/capturas/)
npm --prefix desktop/ui-tests ci && npm --prefix desktop/ui-tests test
# a build with the embedded server, as the release does
ECLUME_SERVER_URL=https://192.168.15.199:8443 ECLUME_SERVER_CA_SHA256=<sha256> cargo build --manifest-path desktop/Cargo.toml -p eclume-desktop
```

The server and the account (on the first run), the extra CA, the per-app policies, the
microphone, the shortcuts, the stop on silence and retention are configured through the window
("Abrir o eclume" in the tray) and live in `config.json` in the app's config directory — the
credential, in the OS keychain. Without touching the file, `ECLUME_WEB_URL`, `ECLUME_API_URL` and
`ECLUME_PAT` override the server, the API and the credential (dev and tests).

The tray icons (`tray-*.png`, one per state) come from the brand through
`uv run --with pillow python scripts/icones_bandeja.py`. The bundle's icons are generated from
`src-tauri/icons/icon.svg`:

```bash
npx @tauri-apps/cli@2 icon src-tauri/icons/icon.svg -o /tmp/icones
# copy only 32x32.png, 128x128.png, 128x128@2x.png, icon.icns, icon.ico and icon.png
```
