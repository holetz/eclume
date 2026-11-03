---
type: project
title: Market references
description: Market solutions evaluated (WhisperX, speaches, Anarlog, Meetily, OpenTranscribe, Scriberr) and how eclume uses each one in the compose strategy.
resource: "**"
tags: [references, market, asr, desktop]
timestamp: 2026-09-24
audience: both
authority: current
source: holetz/eclume#1
maintainer: holetz
---

# Market references

Strategy: **compose**. eclume has its own lean server. The ASR engine is WhisperX,
used as a library in its own GPU worker. The desktop reuses MIT crates from Anarlog. The rest
is inspired by existing solutions, with no forks. Research done on 2026-09-24.

| Solution | License | Use in eclume |
|---|---|---|
| [WhisperX](https://github.com/m-bain/whisperX) (24k★, v3.8.6) | BSD-2 | **Engine**, as a library, in the GPU worker: batched faster-whisper, word-level alignment (pt via community wav2vec2), pyannote `community-1` and speaker embeddings. |
| [whisperx-asr-service](https://github.com/murtaza-nasir/whisperx-asr-service) | MIT | **Reference** for the CUDA Dockerfile, GPU queue and model unloading. Not used as a sidecar (reason below). |
| [speaches](https://github.com/speaches-ai/speaches) (3.7k★) | MIT | Alternative OpenAI-compatible engine (faster-whisper, no diarization), pluggable through the engine interface. |
| [Anarlog](https://github.com/fastrepl/anarlog), formerly Hyprnote (9.4k★, Tauri 2) | MIT | **Rust crates** reused in the desktop: `detect` (mic in use and meeting app, on Windows, Linux and macOS), `audio-*`, `meeting-capture`, `vad`, `resampler`. |
| [Meetily](https://github.com/Zackriya-Solutions/meeting-minutes) | MIT | Desktop UX reference and for mixing the mic with system audio. |
| [OpenTranscribe](https://github.com/attevon-llc/OpenTranscribe) | AGPL-3.0 | **UX reference only**: library, search, speaker profiles and per-user prompts. No code is copied, because of the AGPL. |
| [Scriberr](https://github.com/rishikanthc/Scriberr) | MIT | Reference for API keys, folder watcher and chat over the transcript. |

## Why WhisperX as a library, and not the ready-made container

The server has a GTX 1660 Super with 6 GB of VRAM, Turing TU116 architecture and no tensor cores.

- **A single process.** The worker runs ASR, alignment, diarization and speaker embeddings
  (`return_embeddings=True`) in sequence and loads pyannote only once. With
  whisperx-asr-service as a sidecar, pyannote would be loaded twice in 6 GB, and the voice
  fingerprint would come from a different model than the one used in diarization.
- **Configuration for the card.** `large-v3-turbo` with `compute_type=int8_float16` (~2–3 GB) and
  pyannote `community-1` (~1 GB). Plain `fp16` is avoided because of the history of NaN on the
  GTX 16xx series. One GPU job runs at a time, with idle models unloaded.
- **No resident Ollama.** A local LLM does not fit next to the ASR. This production summarizes with
  `claude -p` (image with `ECLUME_CLAUDE_CLI=1`); the product does not require the CLI, and an API or Ollama,
  which only runs with the ASR queue empty, serve just as well.

## Models used by the GPU worker

Weights are downloaded by the worker and never committed. The full audit, with the sources checked
and the open decisions, is in the root [NOTICE.md](../../NOTICE.md).

| Model | Role | License |
|---|---|---|
| `large-v3-turbo` (faster-whisper conversion of OpenAI Whisper) | ASR | MIT |
| pyannote `speaker-diarization-community-1` | Diarization and speaker embeddings | CC-BY-4.0 (gated: accept the terms on Hugging Face) |
| `jonatasgrosman/wav2vec2-large-xlsr-53-portuguese` | Word alignment (pt) | Apache-2.0 |
| RNNoise `cb.rnnn` (conjoined-burgers) | Noise suppression before ASR | None declared upstream; owner decision pending (see NOTICE.md) |
