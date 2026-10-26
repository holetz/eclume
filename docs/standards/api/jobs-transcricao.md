---
type: standard
title: Transcription job contract (server ↔ GPU worker)
description: The arq queues (`eclume:gpu` and `eclume:default`), the `transcribe` job the server enqueues (with the admin settings, the preprocessing and the encrypted HF token in the options), the audio preprocessing with ffmpeg before ASR, the per-revision artifacts and the `ingest_transcript`/`transcription_failed` jobs the GPU worker returns with the revision in the `_job_id`, progress and heartbeat in Redis, idempotency by `(recording_id, revision)`, the retry of transient failures in the returns, dead-job detection by the server, the ASR kept resident between jobs, JSON serialization without unrestricted pickle and the container allowlist with `-protocol_whitelist` and a timeout in ffmpeg, and the queue wait (`Job.queue`) with the processor's last seen and the estimate from history.
resource: engines/src/eclume_engines/fila.py, server/src/eclume_server/queue.py, server/src/eclume_server/queue_status.py, server/src/eclume_server/dispatch.py, server/src/eclume_server/worker.py, server/src/eclume_server/transcripts.py, worker-gpu/**
tags: [api, jobs, arq, redis, worker, transcricao]
timestamp: 2026-10-05
audience: both
authority: current
source: holetz/eclume#5, holetz/eclume#8, holetz/eclume#12, holetz/eclume#15, holetz/eclume#26, holetz/eclume#32, holetz/eclume#33, holetz/eclume#95, holetz/eclume#96, holetz/eclume#97, holetz/eclume#92, holetz/eclume#94, holetz/eclume#93, holetz/eclume#126, holetz/eclume#98, holetz/eclume#117, holetz/eclume#121, holetz/eclume#144, holetz/eclume#142, holetz/eclume#145
maintainer: holetz
---

# Transcription job contract (server ↔ GPU worker)

The server (`server/`, holetz/eclume#5) and the GPU worker (`worker-gpu/`, holetz/eclume#8) only
talk through queues and the bucket. This is the contract between the two; neither side
reinterprets it, and changing it means changing both sides together.

## Queues

Arq over Redis (`ECLUME_REDIS_URL`), with three queues (holetz/eclume#96):

- `eclume:gpu`, consumed only by `worker-gpu` with `max_jobs=1`;
- `eclume:default`, consumed by the CPU worker of the `server` package (`WorkerSettings`, explicit
  `max_jobs`): `ingest_transcript`, `transcription_failed`, `purge_embedding_objects` and every
  cron (reaper, resume, expired uploads);
- `eclume:agents`, consumed by the agent worker (`AgentWorkerSettings`, service
  `worker`, `max_jobs = ECLUME_AGENT_MAX_JOBS`, default 4 in the code and 2 in the production compose): `detect_agenda_type`,
  `fill_fields`, `summarize`, `summary_chat`, `base_chat`, `agent_turn` (the Agent), `agent_action` (the Agent's
  confirmed action, target by target, rescheduled in 30 s with open summaries at the ceiling) and `run_preview`. Ingestion does not share
  a slot with an agent call. During the transition, the `eclume:default` worker keeps the agent
  functions registered for one version, to drain what was already in its queue.

The GPU worker does not change queues: the returns stay on `eclume:default`.

**Dispatch on the account's turn (holetz/eclume#98).** The GPU queue is fair without touching arq:
each account has at most one `transcribe` in `eclume:gpu`. The job is born `queued` without
`transcription_jobs.dispatched_at` — held in the database — and `dispatch.next_for(owner)`
dispatches it: in a transaction with the account's `pg_advisory_xact_lock`, if it has no open
dispatched job and is within the 24 h audio minutes (`quotas.gpu_minutes_24h`, the sum of
`recordings.duration_ms` of the jobs dispatched in the window), it stamps `dispatched_at` on the
oldest held job and enqueues it after the commit, with the `_job_id`
`transcribe:{recording_id}:{revision}`. With one job per account in arq's FIFO queue, the rotation
between accounts comes for free: ten files from one person do not delay another person's first.
Dispatching happens on: the upload `complete`, retranscribe, the admin retry, `ingest_transcript`
and `transcription_failed` (the GPU became free for the account) and the CPU worker's
`dispatch_transcriptions` cron (every minute, `unique`), a safety net for what none of those cover
— reaper, cancellation, deletion and the minutes window reopening. An account over its minutes
loses nothing: the recording waits, held, until the window opens. The GPU worker does not read the
database and does not know about dispatch.

**Serialization (holetz/eclume#94).** No job or result is deserialized with unrestricted
`pickle`: `eclume_engines.fila` has `serializar` (JSON, `default=str`, which never fails) and
`desserializar` (JSON; bytes with pickle's protocol marker go through an `Unpickler` whose
`find_class` refuses every class, so only primitive types open). Every reader uses
`desserializar`: the server pool (`job_deserializer`), the `WorkerSettings` of the CPU and GPU
workers and the reaper's `Job`. The switch is in two phases (expand/contract): in phase A, only the
readers change and the serializer stays pickle; after it is deployed, phase B passes `serializar`
as `job_serializer` in every producer and worker. That way, no old reader receives JSON and no job
in the queue is lost. A job argument is always `str`, `int`, `float`, `bool`, `None`, `dict` or
`list`.

## Cancellation

Cooperative, by a key in Redis — not `Job.abort()`, which cancels the task but leaves the ASR
running in the thread and frees the `max_jobs=1` slot with the GPU still busy.

- **Who cancels.** `POST /api/v1/recordings/{id}/cancel` (the owner, `recordings:write`; 409
  without a `queued`/`running` job), recording deletion (API, web and MCP) and account deletion. In
  one transaction, locking the recording before reading the job: job `cancelled` with
  `finished_at` and `error_code` `cancelled` (recoverable), recording `failed` and the step in
  progress — preprocessing, if the revision's progress is at `download` or `preprocess`; otherwise,
  transcription — `skipped` with the reason `cancelled`. Retranscribing is the way back.
- **The key.** After the commit, the server writes `eclume:cancel:{recording_id}:{revision}` (TTL 7
  days). If writing fails, it only costs GPU: the result arrives obsolete and is discarded.
- **The worker.** Checks the key when it picks up the job (before the download) and every ~5 s
  while it runs, setting a `threading.Event`; the progress callback, in the engine's thread, raises
  the interruption at the next ASR or diarization batch, and there is a check between download,
  preprocessing, ASR and upload. Alignment and the ffmpeg passes have no check point: the request
  takes effect at their end. Once cancelled, the job enqueues no return, deletes the progress hash
  and the working directory and only then frees the slot. An old worker ignores the key and simply
  does not cancel.

## `transcribe` — the server enqueues

Enqueueing is the server's role. When the upload completes (or on a retranscription), it calls
`transcribe` on `eclume:gpu` with `_job_id="transcribe:{recording_id}:{revision}"` and these
arguments:

- `recording_id: str` (UUID);
- `audio_key: str` — the S3 key of the audio, in the `ECLUME_S3_BUCKET` bucket;
- `options: dict`, with `language` (default `"pt"`), `min_speakers`, `max_speakers`, `engine`,
  `model`, `compute_type`, `diarize: bool` and `embeddings: bool`. The admin settings arrive
  through here; **the worker does not read the database**.
- Added by holetz/eclume#12 (additive: an old worker ignores them), all optional:
  - `batch_size` — the initial ASR batch; the worker's `ECLUME_BATCH_SIZE` wins;
  - `fallback_model` — the model after a persistent OOM (default `medium`);
  - `diarization_model` — the diarization pipeline (default `pyannote/speaker-diarization-community-1`);
  - `endpoint_url` — the base of the `openai-compatible` engine; wins over `ECLUME_REMOTE_BASE_URL`;
  - `hf_token_encrypted` — the platform's Hugging Face token (`platform_secrets`), encrypted. It goes only in the enqueued
    payload, never in `transcription_jobs.options`. Format: `v1:` + base64(12-byte nonce +
    AES-256-GCM ciphertext + tag), with the key from `ECLUME_ENCRYPTION_KEY` (base64 of 32 bytes)
    or, without it, HKDF-SHA256 of `ECLUME_SECRET_KEY` with `info=eclume-secrets-v1` — **the same
    on the server and on the worker**. It wins over `HF_TOKEN` and the file; if it does not open,
    the job goes on with the environment's token and the warning `hf_token_undecryptable`.
- Added by holetz/eclume#33 (additive, optional):
  - `language: null` — automatic language (`asr.default_language: "auto"`): the engine detects,
    the aligner follows the detected one and the raw stores the detected one. Without the key (an
    old job), `pt` applies;
  - `preprocess` — the platform's `preprocessing` block (`denoise`, `loudnorm`, `trim_silence`,
    `split_channels`), which the worker applies before ASR. Without it, the worker only converts
    the format.
- Added by holetz/eclume#174 (additive, optional):
  - `vocabulary` — a list of terms (up to 50 and ~400 characters): the names of the `people` of the
    account that owns the recording, assembled by the server when enqueueing, only in the arq
    payload (never in `transcription_jobs.options`; a requeue recomputes it). `whisperx-local`
    passes them to the ASR as `hotwords` during that job and restores the original options at the
    end, even on error: the resident model does not reload and one account's term does not reach
    the next. The `openai-compatible` engine ignores them.

## Preprocessing

`eclume_worker/preprocess.py`, between the download and the ASR, with the image's `ffmpeg`, in a
thread. The order is fixed:

0. **Container by allowlist** (holetz/eclume#94): the file's first bytes choose the demuxer —
   `OggS` → `ogg`; EBML `1A45DFA3` → `matroska` (Matroska and WebM); `ftyp` at position 4 →
   `mov` (MP4, MOV, M4A); `RIFF…WAVE` → `wav`; `fLaC` → `flac`; `ID3` or MPEG sync → `mp3`;
   ADTS header → `aac`. ffmpeg never guesses the format: every `ffprobe`/`ffmpeg` gets an explicit
   `-f`, `-protocol_whitelist file` and the input as `file:<caminho>`, including the intermediate
   WAVs. HLS playlists, `concat`, SDP and any other container end in `audio_decode_failed` with the
   reason (`contêiner fora da lista permitida`), without calling ffmpeg.
   **Timeout:** 60 s on `ffprobe`; on each `ffmpeg`, 300 s plus the audio's duration, capped at
   4 h (the cap also applies when the duration is unknown). Exceeding the time is a failure like
   any other (it falls into step 5). WhisperX only receives the WAV the preprocessing itself
   produced.
1. **Probe** (`ffprobe`): the audio's channels.
2. **Split channels** (on and only with 2 channels): `pan=mono|c0=c0-c1,volumedetect` with
   `mean_volume` below −60 dB is duplicated mono, and the step ends `skipped` (`dual_mono`);
   otherwise, each channel is an input (`pan=mono|c0=c0` and `pan=mono|c0=c1`). Without splitting,
   the input is the mix (`aformat=channel_layouts=mono`).
3. **Render chain**, one pass per input: `aresample=48000` (RNNoise requires 48 kHz); noise
   reduction `arnndn=m=$ECLUME_RNNOISE_MODEL:mix=<strength>` or
   `afftdn=nr=<6 + 24·strength>:nf=-50`; `loudnorm=I:TP:LRA` (after the noise, so as not to
   amplify it); `aresample=16000`; output `-ac 1 -ar 16000 pcm_s16le`.
4. **Trim silence** (on): `silencedetect` on the already normalized file; a silence that starts at
   the beginning defines where speech starts, and one that runs to the end defines where it ends.
   With split channels, the smallest start and the largest end apply, and the same `atrim` cuts
   both. Silences in the middle stay.
5. **Failure:** the chain with a code ≠ 0 falls back to the format only (`aresample=16000`, mono),
   with the steps `failed` and the warning `preprocess_failed`, and the transcription goes on. If
   not even the format comes out, `audio_decode_failed`. Without the RNNoise model file (dev, CI),
   it uses `afftdn` with the warning `rnnoise_model_missing`.

The treated audio lives only in the working directory: the bucket keeps the original, which the
user listens to. The trim **offset** (`offset_ms`) is added to every segment and word
`start_ms`/`end_ms` of the raw: the timestamps are those of the original audio. The raw's
`duration_ms` is the original's (by `ffprobe`), with the trimmed silences. The trim applies to all
channels or to none: each channel is trimmed into a temporary file, and the swap only happens when
all of them are out.

**Split channels in the ASR:** the engine runs once per channel with
`min_speakers = max_speakers = 1` (which keeps the speaker embedding for voice identification);
each channel's speech gets its own label, the segments merge by start and the speakers become
`S1`, `S2` in order of first speech. The engine does not change.

## The GPU worker returns

1. Downloads the audio from S3, runs the pipeline and writes `recordings/{recording_id}/r{revision}/transcript.raw.json`
   in the same bucket (the `revision` is the one in the `transcribe`'s `_job_id`).
2. The file follows [`contracts/transcript.schema.json`](/contracts/transcript.schema.json):
   segments, words and speakers with `label` "Locutor N", **without** `person`/`suggestions`, which
   belong to the server.
3. Also writes a `speaker_embeddings` with `{speaker_id: [float, ...]}` and `embedding_model`, in
   a separate file: `recordings/{recording_id}/r{revision}/speaker_embeddings.json`. The server
   puts it in the bucket deletion queue in the ingestion transaction, whether the vector was kept
   or discarded: the biometrics live only in the database (holetz/eclume#97).
4. Then enqueues `ingest_transcript(recording_id, transcript_key, embeddings_key,
   engine_info)` on `eclume:default`, with `_job_id="ingest_transcript:{recording_id}:{revision}"`.
   `engine_info` carries engine, model, `compute_type`, duration, real time and peak VRAM.
5. On failure, enqueues `transcription_failed(recording_id, error_code, message, stage)` on
   `eclume:default`, with `_job_id="transcription_failed:{recording_id}:{revision}"`. `stage` is
   the last progress step (`preprocess`, `asr`…), which the server uses to mark the right pipeline
   step; an old worker does not send it, and transcription applies.

The revision travels only in the `_job_id` (holetz/eclume#95): the positional arguments do not
change, and an old server ingests the new worker's return. The server reads the revision requiring
the prefix `{job}:{recording_id}:` and an integer ≥ 1; without that (old worker, an id drawn by
arq), the old rule applies, the recording's most recent job, and the keys the job carries
(including the old ones, without `r{revision}/`). The same `_job_id` deduplicates a repeated return
of the same revision.

## Progress

The worker writes `HSET eclume:progress:{recording_id}` with `revision`, `stage` (`download`,
`preprocess`, `asr`, `align`, `diarize`, `embed` or `upload`), `pct` (0–100) and `updated_at`, with
a TTL of 1 day. The server reads it for the job state. The hash also carries `started_at` (RFC 3339
UTC), the job's start, written from the first write on.

`transcription_jobs.started_at` is the job's real start on the GPU worker (holetz/eclume#93): on
success, the `engine_info.started_at` of `ingest_transcript`; on failure, the `started_at` of the
progress hash read by `transcription_failed` (never after the end). With neither, what was already
stored or the queue entry stays. The preprocessing and transcription durations start from that
start, without the queue wait.

The `revision` (holetz/eclume#95) says which revision the progress belongs to: the recording
screen, the admin's Health and the reaper only use the hash whose revision is that of the open job;
a hash without the field (old worker) counts. The key does not change, so the new server sees the
old worker's progress.

## GPU worker heartbeat

Added by holetz/eclume#12. Every 15 s the worker **replaces** the hash
`eclume:gpu:health` (`DEL` + `HSET` + `EXPIRE 45`, in a transaction) and deletes it on shutdown.
Missing hash = worker stopped for more than 45 s. Fields, all text:

| Field | What it is |
|---|---|
| `updated_at` | the heartbeat instant (RFC 3339 UTC) |
| `worker_version`, `engine`, `device` | the `eclume_worker` version, the process's engine (the one forced by `ECLUME_ENGINE`, the last used or `whisperx-local`) and device |
| `busy` | `1` from start to end of a `transcribe` (download, preprocessing, ASR, upload and enqueueing the return), `0` idle |
| `job_id` | the `_job_id` of the `transcribe` in progress (`transcribe:{recording_id}:{revision}`); absent when idle and on an old worker |
| `models` | JSON `[{name, kind, loaded_at, vram_mb}]` of the resident model (`kind` in `asr`, `alignment`, `diarization`); `[]` with no model |
| `gpu_name`, `vram_total_mb`, `vram_used_mb`, `utilization_pct` | NVML reading of the whole device; absent without NVML (`cpu` engine) |

A model's `vram_mb` is the device's usage after loading it minus the usage before. The server reads
the hash for `GET /api/v1/admin/health` ([server-admin.md](../code/server-admin.md)).

**Last seen.** The `reap_stalled_jobs` cron (every minute) writes the `updated_at` of the present
heartbeat to `eclume:gpu:last_seen`, before looking at the jobs and even with no open job. With the
hash missing, that value is the queue wait's "offline since" (1 min precision); without it, there
never was a heartbeat. Nothing changes in the GPU worker.

## The server ingests

`ingest_transcript` persists the transcript in Postgres, indexes it for FTS and stores the
embeddings (pgvector column, dimension by model). In the same transaction, it restores the
speaker↔person links of a retranscription and compares the speakers with the voiceprints of the
people in the account's directory (with voice identification on at the platform), storing the
suggestions above the threshold
([identificacao-por-voz.md](/docs/standards/code/identificacao-por-voz.md)). Then it changes the
recording's state to `transcribed` and writes the `speakers` step: with the account requiring
speaker naming and some speaker without a person, `waiting`, and `ingest_transcript` does not
enqueue `detect_agenda_type` (`Ingested.waiting`); otherwise, `done` and the chain goes on
([processamento-automatico.md](/docs/standards/code/processamento-automatico.md#marcação-dos-locutores)).

- **Non-finite embedding.** Ingestion also discards a vector with NaN or infinity (old worker, file
  already in the bucket): pgvector would refuse it and undo the whole ingestion.
- **Only the message's revision job.** `ingest_transcript` and `transcription_failed` close only
  the message's `(recording_id, revision)` job. If that job is not `queued`/`running` — already
  ingested, failed by the reaper, or from a revision before a retranscription —, the message is
  obsolete: it is logged and ignored, without writing a transcript, without marking a failure,
  without touching the progress hash or the artifacts. Only whoever closes the job deletes the
  hash.
- **A transient failure retries.** A refused, dropped or timed-out connection to Postgres or S3
  (the `ConnectionError`/`TimeoutError` family, `socket.gaierror`, `botocore` connection and
  timeout errors, `ClientError` HTTP ≥ 500 or `SlowDown`), an exhausted pool,
  `OperationalError`/`InterfaceError` or `DBAPIError` with `connection_invalidated`, deadlock and
  serialization failure — in the exception or in its cause (`__cause__`, `orig`) — go back to the
  queue through `Retry`, raised outside the transaction, with the waits
  `INGEST_RETRY_DELAYS_S = (15, 60, 240)` s; both functions are registered with `max_tries=4`. The
  waits add up to 315 s, below `ECLUME_JOB_STALL_SECONDS`, and the reaper does not decide in the
  middle of them. Classification in `eclume_server/transient.py`.
- **Ingestion that fails.** Any exception undoes the whole transaction (neither the transcript nor
  the GPU worker's steps remain). A definitive one — invalid data, malformed JSON, `NoSuchKey`, an
  integrity violation —, or a transient one on the fourth attempt, makes `ingest_transcript` mark,
  in a new transaction, the revision's job and the recording with the usual `fail()`, code
  `ingest_failed` (recoverable), and log the exception. Retranscribing resolves it. A
  `transcription_failed` that exhausts its attempts re-raises, and the reaper covers the job.

## Idempotency

Reprocessing the same `revision` overwrites the artifacts of `r{revision}/`; `ingest_transcript`
is idempotent by `(recording_id, revision)`.

**One revision kept.** After the commit of the ingestion that writes revision N, the server deletes
under `recordings/{recording_id}/` everything not in `r{N}/`, including the old keys without a
revision. A failure in that cleanup only goes to the log; the rest goes on the next ingestion or on
the recording's deletion, which deletes the whole prefix. Keeping every revision would multiply
copies of biometric data (LGPD) with no consumer.

## Dead job

With `max_tries=1`, a GPU worker that dies in the middle of `transcribe` (OOM kill, restart,
deploy) does not enqueue `transcription_failed`. The server notices on its own: the CPU worker's
`reap_stalled_jobs` cron (`eclume_server/stalled.py`, every minute, `unique`) examines the
`queued`/`running` jobs **dispatched** more than `ECLUME_JOB_GRACE_SECONDS` (120 s) ago and crosses
the job's state in arq, the progress hash and the heartbeat:

| Situation | Verdict |
|---|---|
| held in the database, without `dispatched_at` (waiting for the account's turn or the minutes window) | nothing — it is not in arq, it is not a dead job |
| in arq `queued`/`deferred` (delayed queue) | nothing — a queue is not a failure |
| arq `complete` with success up to `ECLUME_JOB_STALL_SECONDS` ago (the ingestion may be in the `eclume:default` queue) | nothing |
| arq `complete` with success more than `ECLUME_JOB_STALL_SECONDS` ago and the job still open in the database (the ingestion was lost) | `ingest_failed` |
| arq `complete` with failure (arq's retry ended the job of a dead worker) | `worker_lost` |
| `queued` in the database, gone from arq (`not_found`) and without a progress hash, for the first time | requeued with the same `_job_id`, the job's `options` and the encrypted HF token; marks `eclume:reaper:requeued:<_job_id>` (7 days) |
| gone from arq (`not_found`) and without a progress hash, with the mark (or already `running`) | `job_lost` |
| progress without a write for more than `ECLUME_JOB_STALL_SECONDS` (1800 s), even with a live worker | `job_stalled` |
| the worker is not on this job (heartbeat missing, `busy=0`, or a `job_id` of another `transcribe`) and the revision's progress missing or without a write for longer than the grace | `worker_lost` |

The worker is "on this job" with the heartbeat present, `busy=1` and a `job_id` equal to
`transcribe:{recording_id}:{revision}` (or without `job_id`, an old worker). A progress hash of
another revision counts as missing. The heartbeat is the sign of life; the progress measures
stalling.

- **Deploy drains, it does not kill.** The GPU `WorkerSettings` has
  `job_completion_wait = job_timeout`: on SIGTERM arq stops picking up jobs and finishes the
  current one, and the jobs in the `eclume:gpu` queue go on to the new worker. `deploy.sh` reads
  `busy` in the heartbeat and, with the GPU busy, waits up to `--espera-gpu` (30 min) before
  recreating `worker-gpu` (`stop_grace_period: 40m`); at the end of the wait it refuses, unless
  `--interromper-gpu`. Without that flag, a deploy does not produce `worker_lost`.
- **Two observations.** Nothing is marked the first time: the suspicion stays in
  `eclume:reaper:suspect:<_job_id>` (code and instant) and only becomes a failure if the same
  diagnosis lasts the whole grace. That covers the worker that just picked up the job and has not
  published progress or heartbeat yet.
- **Recoverable failure.** The verdict goes through the same `fail()` as `transcription_failed`,
  with the row's revision (job and recording `failed`, hash deleted), with a message in pt-BR.
  `worker_lost`, `job_lost`, `job_stalled`, `ingest_failed`, `gpu_oom`, `out_of_memory`,
  `audio_download_failed` and `upload_failed` come out with `Job.error.retryable = true` (contract
  1.4.0; `ingest_failed` since 2.5.0). An ingestion that fails
  with an exception marks `ingest_failed` on its own ([The server ingests](#the-server-ingests));
  the reaper covers the one that never got to run.
- **Retrying is explicit.** The owner retranscribes (`POST /recordings/{id}/retranscribe`); the
  admin retries any user's recording through `POST /admin/jobs/{job_id}/retry`
  ([server-admin.md](../code/server-admin.md)). Both create the next revision with the current
  settings. There is no automatic retry of `transcribe`: it would repeat an OOM or a bad audio in a
  loop; only the return jobs retry transient failures. The exception is the `transcribe` whose
  enqueueing was lost: it never ran, so it goes back to the queue once (table above).
- **Proof.** `server/tests/test_stalled.py`, one test per table row; the ingestion that fails in
  `server/tests/test_pipeline.py`.

## Without a GPU: dev and production

`ECLUME_ENGINE=cpu` (faster-whisper `small` int8, without alignment and **without diarization**:
the raw comes out with one speaker). It applies in dev
([desenvolver-sem-gpu.md](../../how-to/desenvolver-sem-gpu.md)), in E2E and also **in production**
on a host without an NVIDIA GPU: `deploy/deploy.sh --sem-gpu` adds
`deploy/docker-compose.cpu.yml`, which sets `ECLUME_ENGINE=cpu` and `ECLUME_DEVICE=cpu` on
`worker-gpu` and zeroes its GPU reservation (`deploy: !reset {}`, Compose 2.24+), with the same
image. The queue, the job contract and the raw are the same; the heartbeat comes out without the
NVML fields ([auto-hospedar.md](../../how-to/auto-hospedar.md#sem-gpu)). The server tests use a
fake worker that publishes a fixture `transcript.raw.json` from `contracts/fixtures/`.

## How the server does its part

- **Options.** `options` comes from the platform settings (`platform_settings`) and the account.
  The language is resolved **once, when enqueueing** (upload, retranscribe and the admin retry go
  through `insert_job`), in this order: the file's (`recordings.language`, given on upload, on the
  `PATCH` or on retranscribe), the account's preferred one (`users.transcription_language`,
  `GET`/`PATCH /me/transcription`), the server default (`asr.default_language`) and `pt`; it goes
  without a region (`pt-BR` → `pt`). Changing the account's preference does not touch jobs already
  enqueued. `auto` at any level is a request for detection (`options.language = null`), never a
  result: ingestion writes to `recordings.language` and to the transcript the detected language
  (the raw's) and, without it, the resolved default; `auto` only appears on the recording while
  detection has not run. `diarize` is diarization switched on; `embeddings` is only `true` with
  voice identification on at the platform (LGPD).
- **Revision.** The job's `revision` is that of the transcript it will produce: 1 on the first;
  on a retranscription, one above the largest between the transcript and the last job. Every path
  that creates a revision or closes the job (retranscribe, admin retry, `ingest`, `fail`) locks the
  `recordings` row with `SELECT … FOR UPDATE` in its own statement and only then reads the job in
  another: under READ COMMITTED, whoever waited for the lock sees the new job, and the second of two
  simultaneous requests gets 409 in problem+json.
- **Job state.** With the progress hash present, the job shows `running` and the recording
  `processing`; `stage` becomes contract v1's `Job.stage` (`download`/`asr` → `asr`, `align` →
  `alignment`, `diarize` → `diarization`, `embed` → `embeddings`, `upload` → `finalizing`) and
  `progress = pct / 100`, only with the hash of the open job's revision (or without `revision`).
  `ingest_transcript` and `transcription_failed` delete the hash only when they close the job.
- **Tolerant ingestion.** The raw is read with defaults for whatever is missing and ignoring what
  is unknown; a speaker id outside `S<n>` is renumbered in order of appearance, and the same map
  applies to the embeddings. With the job already `succeeded`, `ingest_transcript` does nothing.
- **Queue wait** (`queue_status.py`, holetz/eclume#117). `Job.queue` is computed on read
  (`render`), only for the recordings with a `queued` job without progress, once per response: a
  `ZRANGE` of `eclume:gpu`, the presence of the heartbeat, the last seen and, for the held ones, a
  query of the account. Dispatched (`dispatched_at`): `processor_queue` with `ahead` = the position
  of the `_job_id` in the ZSET, which includes the running job. Held: `quota_window` with
  `resumes_at` when the account, with no dispatched job, is outside its 24 h minutes (the instant
  when the oldest dispatch that brings it below the quota leaves the window); otherwise
  `account_turn` with `account_ahead` = the account's open jobs before it (the dispatched one
  first, then the held ones by `queued_at`). `processor.online` = heartbeat present.
- **Estimate.** Pace (ritmo) = the median of `(finished_at − started_at) / duration_ms` of the last 20
  successful transcriptions in 7 days, across the whole platform (numbers only, connection role),
  and the median processing time; kept 5 min in `eclume:queue:pace`; with fewer than 5 samples, no
  estimate. Estimated start = now + the sum, for each job ahead, of `duration_ms × ritmo` (without a
  duration, the median processing time), minus, for the running one, the time elapsed since the
  progress hash's `started_at` (never negative). Processor offline: `null`.
- **Proof.** `server/tests/test_pipeline.py` runs the cycle with the fake GPU worker of
  `server/tests/eclume_server_testing/fakes.py` and the real CPU worker.

## How the worker does its part

- **Execution.** `max_jobs=1` and `max_tries=1`. A failure does not re-raise the exception: the
  worker enqueues `transcription_failed` and ends the job, and the retry is the server's decision.
  The `revision` is read from the `_job_id`; without it, 1 applies. It goes to the progress hash,
  to the `r{revision}/` keys and to the `_job_id` of both returns. The job in progress stays marked
  from start to end (including enqueueing the return), and the heartbeat publishes `busy` and
  `job_id` from it.
- **Engine.** `ECLUME_ENGINE`, when set in the worker's process, forces the engine (dev without a
  GPU and E2E: `cpu`). Empty, `options.engine` applies, and failing it, `whisperx-local`. A forced
  engine different from `options.engine` ignores the job's `model`, `compute_type`, `batch_size`
  and `fallback_model` — they belong to the engine the admin chose — and uses its own defaults. The
  `cpu` engine does not diarize, and the raw comes out with one speaker.
- **Resident ASR.** In `whisperx-local`, the ASR stays loaded between jobs, next to a slot for the
  step's model (alignment or diarization). Before loading a step's model with less than
  `ECLUME_RESIDENT_MIN_FREE_MB` (2500) free, the ASR leaves; an OOM in a step with the ASR resident
  unloads it and repeats the step once. On every OOM fallback (of the ASR or of the step), the
  previous model leaves VRAM before the new attempt. At the end of the job, the step's model
  leaves, also when a step fails, and the ASR stays until unloaded for idleness
  (`ECLUME_MODEL_IDLE_SECONDS`, 300 s).
  `ECLUME_KEEP_ASR_RESIDENT=0` goes back to one model at a time. The heartbeat declares the
  resident ones.
- **Language.** The engine receives only the language of `language` (`pt-BR` → `pt`), and the raw
  stores the value received; with `language: null`, the engine detects and the raw stores the
  detected one.
- **Raw.** Speakers `S1..Sn` in order of first speech, `label` `Locutor N`, `talk_ms` and
  `person: null`, which the schema requires; never `suggestions`. Without diarization, a single
  speaker (`S1`). The worker fills `recording_id`, `language`, `duration_ms`, `content_hash`
  (sha256 of the downloaded audio), `revision`, `engine`, `speakers` and `segments` with words. The
  fields only the server knows (`id`, `title`, `owner`, `recorded_at`, `source`, `created_at`,
  `updated_at`) come out **provisional**, only so the file validates against the schema; ingestion
  ignores them.
- **Embeddings.** The file is always written, keyed by the raw's ids:
  `{"embedding_model": "pyannote/wespeaker-voxceleb-resnet34-LM", "dimension": 256,
  "speaker_embeddings": {"S1": [...]}}`. Without diarization, `speaker_embeddings` is `{}`, and
  `embedding_model` and `dimension` are `null`. A vector with any non-finite component (NaN or
  infinity — pyannote produces it for speech that is too short) is left out: the speaker stays in
  the raw, just without an embedding. It is not an error.
- **Degraded diarization.** Without a Hugging Face token, or without access to the gated model
  (terms not accepted), the worker transcribes with one speaker and warns in
  `engine_info.warnings` (`diarization_skipped_no_token`, `diarization_skipped_no_access`). Any
  other diarization error fails the job.
- **Progress.** The `pct` is the job's overall one and never goes back, with one band per step:
  `download` 0–3, `preprocess` 3–10, `asr` 10–55, `align` 55–70, `diarize` 70–90, `embed` 90–95 and
  `upload` 95–100. A step that does not run is skipped. `pct` 100 is written **before**
  `ingest_transcript` is enqueued, so as not to recreate the hash the ingestion deletes.

`engine_info`:

| Field | What it is |
|---|---|
| `started_at` | the job's start (RFC 3339 UTC), the same as the progress hash's |
| `preprocess` | `{steps: [{step, state, params?, reason?, error?}], ms, offset_ms, channels, split, fallback, warnings, ffmpeg_version}`: what the preprocessing did |
| `engine`, `model`, `compute_type`, `batch_size` | how the ASR ran (the model falls back to `medium` on a persistent OOM) |
| `language` | the language passed to the engine, or the detected one with automatic language |
| `duration_ms` | the audio's duration |
| `processing_ms`, `job_ms` | the engine's time and the job's total time, with download and upload |
| `realtime_factor` | `processing_ms / duration_ms` |
| `peak_vram_mb` | VRAM peak above the baseline before the job (NVML), or `null` |
| `align_model`, `diarization_model`, `embedding_model` | the models used; `null` when the step did not run |
| `warnings` | warnings (`diarization_skipped_no_token`, `diarization_skipped_no_access`, `fallback_medium` — also with another `fallback_model` —, `batch_size_reduced`, `compute_type_float16_rejected`, `alignment_unavailable`, `hf_token_undecryptable`, `preprocess_failed`, `rnnoise_model_missing`) |
| `worker_version` | the `eclume_worker` version |

`error_code` of `transcription_failed`:

| `error_code` | When |
|---|---|
| `audio_download_failed` | the `audio_key` does not exist or S3 failed |
| `audio_decode_failed` | the container is outside the allowlist, or ffmpeg cannot decode the audio even just to convert the format (within the timeout) |
| `out_of_memory` | VRAM runs out even with batch 1 and the `medium` model |
| `asr_failed` | an ASR error that is not lack of memory |
| `alignment_failed` | an error in word alignment |
| `diarization_failed` | an error in diarization with the model accessible |
| `upload_failed` | failure writing the artifacts to the bucket |
| `internal_error` | an unknown or misconfigured engine, or an unexpected error |

The worker-side proof is `worker-gpu/tests/test_jobs.py` (fakes) and
`worker-gpu/tests/test_gpu_e2e.py`, which runs on the GPU host against `deploy/docker-compose.gpu-test.yml`.
