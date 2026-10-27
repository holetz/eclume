# eclume

A self-hosted institutional transcription service. eclume records work meetings, transcribes them
on your own server's GPU, separates and recognizes the speakers, organizes the transcripts by
person and summarizes them with the agents the platform admin configures. Every user has their own
space; there is no organization layer.

## Features

- **Capture on any device.** A desktop app for Windows and Linux detects meetings, records them,
  takes voice notes and syncs from the system tray; an Android app works as a portable microphone
  that keeps recording with the screen locked and marks moments; the web app imports audio and
  video files, converting them locally before upload.
- **Automatic processing.** Preprocessing, transcription with word alignment and diarization
  (WhisperX on CUDA), then agenda type detection, field filling and a summary written by a language
  model provider the admin registers.
- **Recognize people by voice.** Speakers are linked to people in each user's directory, by hand
  or by voiceprint suggestions.
- **A library in time.** Recordings on a week, month or list calendar, with full-text search,
  people, collections, tags and filters.
- **Summary-centered recordings.** Summaries are versioned and editable by hand or through an
  adjustment chat, and the Agent answers questions across the whole library.
- **Integrations.** A versioned API contract (OpenAPI v1) with personal access tokens, an MCP
  server for assistants, and a synced folder on the desktop.
- **Privacy by design.** Each account sees only its own data, the admin operates the platform
  without access to recordings, transcripts or summaries, and nothing records without showing it.

## Architecture

eclume is a monorepo with one pillar per top-level folder:

- **server/**: FastAPI API with isolated user accounts (open sign-up), a separate admin account,
  PATs, recordings, people and search.
- **worker-gpu/**: WhisperX (ASR, alignment, diarization and speaker embeddings) on CUDA.
- **web/**: the user interface and the admin panel, with local audio and video conversion before
  upload.
- **desktop/**: a Tauri app for Windows and Linux that detects meetings, records, syncs and lives
  in the system tray.
- **mobile/**: a Tauri 2 app for Android, a portable microphone that records with a foreground
  service, marks moments and syncs with the server.
- **engines/**: the ASR engine interface, shared by the server and the worker.
- **contracts/**: the OpenAPI v1 and the transcript schema, the contract with external
  integrations.
- **deploy/**: the development and test composes (Postgres with pgvector, Redis and MinIO), the
  production compose for the GPU host, and the deploy, backup and desktop release scripts.
- **docs/**: the project's knowledge, as an OKF bundle.

## Self-hosting

To run eclume on your own server, with or without a GPU, follow
[docs/how-to/auto-hospedar.md](docs/how-to/auto-hospedar.md).

## Development

From a fresh clone to a transcribed recording on a machine without a GPU:
[docs/how-to/desenvolver-sem-gpu.md](docs/how-to/desenvolver-sem-gpu.md). The build, lint and test
commands of each pillar are in [docs/standards/code/monorepo.md](docs/standards/code/monorepo.md).

## License

MIT. See [LICENSE](LICENSE).
