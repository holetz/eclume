# eclume — mobile app

The phone as eclume's portable microphone: it records Ogg/Opus mono 16 kHz with the screen
locked, marks moments with an optional note and keeps the recordings while away from the server.
Back on the server network's Wi-Fi, it syncs on its own, with the same resumable upload as the
desktop. The app does not read transcripts.

- **Stack:** Tauri 2 mobile, Android first (iOS is left to its own spec). The UI is React + TS
  over eclume's DS; the Rust core (`crates/core`) reuses the desktop's recording and sync crates
  (`../desktop/crates`).
- **Architecture and contracts:** [docs/standards/code/mobile-app.md](../docs/standards/code/mobile-app.md).
- **Commands:** [docs/standards/code/monorepo.md](../docs/standards/code/monorepo.md#mobile--npm-and-cargo-workspace-in-mobile).
- **Android environment on the host:** `scripts/android-sdk.sh`
  ([docs/project/host-setup.md](../docs/project/host-setup.md)).

```bash
npm --prefix mobile ci
npm --prefix mobile test
remote-run . 'source ~/.config/eclume/android-env.sh && npm --prefix mobile ci && npm --prefix mobile run tauri -- android build --debug --apk --target x86_64'
```
