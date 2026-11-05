# eclume-detect — what comes from Anarlog

- Source: <https://github.com/fastrepl/anarlog>, `crates/detect`
- Pinned commit: `bfb8d9e4ff7fcc8c9aeab2f52cc020d16b195e43`
- License: MIT — `Copyright (c) 2023-present Fastrepl, Inc.` (full text in `LICENSE`)

This crate **is not a copy** of `detect`: it adapts the part that reads OS signals. The
original includes `meeting_ax` (accessibility tree reading, ~8 thousand lines), `specta`,
`anlg-*`, a tokio runtime per detector and event callbacks, which eclume does not use. Here collection
returns a snapshot (`Snapshot`) queried every second, and classification, debounce and
automatic recording are our own, pure and tested with mocked signals.

| File here | Source | What changed |
|---|---|---|
| `src/platform/linux.rs` | `src/list/linux.rs` (`list_mic_using_apps`) | Same query for non-corked source-outputs through Pulse's standard mainloop, with the same timeout; adds a source query to discard monitor readers (system audio capture) and `application.process.id` to exclude the app itself; errors in `anyhow`. |
| `src/platform/macos.rs` | `src/list/macos.rs` (`list_mic_using_apps`) and `src/mic/macos/device.rs` (`is_mic_running`) | Same Core Audio process list with `is_running_input` and the same default device's `DeviceIsRunningSomewhere`, without listeners or bundle resolution; the name comes from `sysinfo` and the device fallback adds the process list. |
| `src/platform/windows.rs` | — | Written by eclume: the original lists active WASAPI sessions; here the source is the Capability Access Manager's `ConsentStore`, which provides the executable without opening COM, plus window titles through `EnumWindows`. |
| `src/classify.rs`, `src/debounce.rs`, `src/auto.rs`, `src/platform/mod.rs` | — | Written by eclume. The meeting app list (`zoom`, `teams`, `teams-for-linux`, `webex`, `CiscoCollabHost`, `slack`) follows the original `src/app/linux.rs`; `whatsapp` was added by eclume. |

Adapted files carry the source line at the top. To update, compare the source file at a newer commit
with the local one, port the fixes and record the new SHA on this page.
