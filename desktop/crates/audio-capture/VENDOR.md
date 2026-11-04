# eclume-audio-capture — what comes from Anarlog

- Source: <https://github.com/fastrepl/anarlog>, `crates/audio-actual`
- Pinned commit: `bfb8d9e4ff7fcc8c9aeab2f52cc020d16b195e43`
- License: MIT — `Copyright (c) 2023-present Fastrepl, Inc.` (full text in `LICENSE`)

This crate **is not a copy** of `audio-actual`: it is an adaptation. The original dependency graph
pulls in `aec` (~65 MB ONNX models), `audio-sync`, `audio-device`, `rodio` and async streams, which
eclume does not use. Each platform's device logic was kept and the interface replaced.

| File here | Source | What changed |
|---|---|---|
| `src/system/linux.rs` | `src/speaker/linux.rs` | PipeWire following the active sink, with Pulse monitor fallback, as in the original; the async ring buffer (`RingbufAsyncReader` + `AtomicWaker`) became this crate's `RingWriter`; downmix by averaging instead of using only the first channel; `tracing` → `log`. Added by eclume: sink listing (`list_output_devices`, id = node name) and capture of a selected sink's monitor (`target.object` in PipeWire, `<sink>.monitor` in Pulse), falling back to the active sink if the selected one is missing. |
| `src/system/windows.rs` | `src/speaker/windows.rs` | WASAPI loopback following the active endpoint, as in the original; same ring buffer, downmix and log changes. Added by eclume: listing active endpoints (endpoint id) and fixed loopback on a selected endpoint, without following switches; if it is missing, follows the active one. |
| `src/system/macos.rs` | `src/speaker/macos.rs` | Core Audio process tap + aggregate device, as in the original; same ring buffer and log changes. The global tap follows the active output: the output list is empty and a selected output is ignored with a warning. |
| `src/ring.rs` | `src/rt_ring.rs` (idea) | Rewritten: a `ringbuf` ring buffer with a producer in the audio callback and blocking reads with a timeout. |
| `src/mic.rs` | — | Written by eclume: `cpal` directly on the default input device (the original `mic.rs` couples AEC and the joiner). |

Adapted files carry the source line at the top. To update, compare the source file at a newer commit
with the local one, port the fixes and record the new SHA on this page.
