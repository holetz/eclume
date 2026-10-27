---
type: how-to
title: Develop eclume without a GPU
description: From clone to a transcribed and summarized recording on a Linux or Windows machine without a GPU and without the build host — dev compose services, migrate, admin, API over HTTP, workers, transcription worker on the cpu engine, web pointing at the API, and the local equivalent of each remote-run (browser tests, E2E and Android build).
resource: deploy/docker-compose.dev.yml, deploy/.env.example, deploy/docker-compose.mock.yml, server/src/eclume_server/config.py, worker-gpu/src/eclume_worker/config.py, web/vite.config.ts
tags: [desenvolvimento, cpu, sem-gpu, dev]
timestamp: 2026-10-01
audience: both
source: holetz/eclume#126
maintainer: holetz
---

# Develop eclume without a GPU

The development loop runs entirely on an ordinary machine: the transcription worker uses the `cpu`
engine (faster-whisper `small` int8, no diarization), and the project's build host
(`remote-run`, in [monorepo.md](../standards/code/monorepo.md)) is a convenience, not a
requirement. The lint and test commands of each pillar are in
[monorepo.md](../standards/code/monorepo.md); this guide goes from the clone to a transcribed and
summarized recording.

## Prerequisites

- Git, Docker with the Compose plugin, [`uv`](https://docs.astral.sh/uv/), Node.js 22 and `ffmpeg` on the
  `PATH` (the worker's preprocessing calls it).
- **Windows:** Docker Desktop with WSL 2. The simplest is to run everything inside a WSL
  distribution (Ubuntu), with the commands below unchanged; in native PowerShell, replace `VAR=value cmd`
  with `$env:VAR="value"; cmd`.
- The desktop and the phone (Rust, Tauri, Android) are only needed to work on them; the
  system dependencies are in [monorepo.md](../standards/code/monorepo.md).

## 1. Clone and dependencies

```bash
git clone https://github.com/holetz/eclume.git && cd eclume
uv sync --all-packages
npm --prefix web ci
```

## 2. Services

The dev compose brings up Postgres (with pgvector), Redis and MinIO on `127.0.0.1`, with the dev passwords
the server already uses by default. The bucket is created once:

```bash
docker compose -f deploy/docker-compose.dev.yml up -d
docker compose -f deploy/docker-compose.dev.yml exec minio \
  sh -c 'mc alias set local http://127.0.0.1:9000 eclume eclume-dev-secret && mc mb --ignore-existing local/eclume'
```

Occupied ports are changed through `deploy/.env` (copy from `deploy/.env.example`); when you change one, pass the
matching URL to the server and the workers (`ECLUME_DATABASE_URL`, `ECLUME_REDIS_URL`,
`ECLUME_S3_ENDPOINT`).

## 3. Database and admin

```bash
uv run eclume-server migrate
printf '%s' 'local-admin-password' \
  | uv run eclume-server admin create --email admin@example.com --name Admin --password-stdin
```

## 4. API and workers

Each in its own terminal. The API over plain HTTP needs `ECLUME_COOKIE_SECURE=false`, or the session
cookie does not return to the browser:

```bash
ECLUME_COOKIE_SECURE=false uv run uvicorn eclume_server.app:create_app --factory
uv run arq eclume_server.worker.WorkerSettings          # queue eclume:default (ingestion, resume)
uv run arq eclume_server.worker.AgentWorkerSettings     # queue eclume:agents (summaries)
```

The transcription worker, on the `cpu` engine, with the `cpu` extra (faster-whisper; no torch):

```bash
ECLUME_ENGINE=cpu ECLUME_DEVICE=cpu \
ECLUME_S3_ENDPOINT_URL=http://127.0.0.1:9000 ECLUME_S3_ACCESS_KEY=eclume ECLUME_S3_SECRET_KEY=eclume-dev-secret \
  uv run --package eclume-worker --extra cpu arq eclume_worker.worker.WorkerSettings
```

The first job downloads the `small` model (~0.5 GB) into the user's Hugging Face cache. The
transcription comes out with a single speaker: the `cpu` engine does not diarize
([jobs-transcricao.md](../standards/api/jobs-transcricao.md#como-o-worker-cumpre-a-sua-parte)).

## 5. Web

```bash
ECLUME_API_URL=http://127.0.0.1:8000 npm --prefix web run dev
```

Open `http://localhost:5173`, create an account at **Criar conta** and upload a short recording: it
goes through `processing` until `done` with the transcription. The browser microphone only works on
`localhost` or HTTPS.

## 6. Summary

Sign in to the panel at `http://localhost:5173/admin/entrar` with the admin from step 3 and register a
provider in **Admin → Agentes**: an API key, or an OpenAI-API-compatible server on your
network (e.g. a local model). The matrix of what each type requires is in
[server-agentes.md](../standards/code/server-agentes.md#o-que-cada-provider-exige). With it
registered, the transcribed recording gets its summary.

## Without the build host: the local equivalent of each `remote-run`

The `remote-run`s of [monorepo.md](../standards/code/monorepo.md) sync the checkout to the build host
and run there; locally, the same command runs at the checkout root:

| `remote-run` | Local |
|---|---|
| `remote-run web '… npm run test:browser'` | `cd web && npx playwright install webkit firefox && npm run fixtures && npm run test:browser` |
| `remote-run . '… docker-compose.mock.yml … npm run test:e2e'` | `docker compose -p eclume-mock-web -f deploy/docker-compose.mock.yml up -d --wait && cd web && npx playwright install chromium && npm run test:e2e` |
| `remote-run . 'source ~/.config/eclume/android-env.sh && … android build …'` | install the SDK once with `bash mobile/scripts/android-sdk.sh` and run `source ~/.config/eclume/android-env.sh && npm --prefix mobile ci && npm --prefix mobile run tauri -- android build --debug --apk --target x86_64` |
| `cargo …` of the desktop and mobile pillars | the same commands, with the Tauri system dependencies installed |

The browser tests need Google Chrome installed; the E2E uses the mock's port 4010 (another one
through `ECLUME_MOCK_PORT` and `ECLUME_MOCK_URL`). The Android build takes ~8 GB of SDK, JDK and NDK in `~/`.
