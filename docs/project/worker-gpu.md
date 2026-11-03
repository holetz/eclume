---
type: project
title: GPU worker on the GTX 1660 SUPER
description: How the eclume GPU worker (WhisperX large-v3-turbo, pt wav2vec2 alignment, pyannote community-1 diarization) runs on the host 192.168.15.199 — compute type, measured benchmark, image, preprocessing with the RNNoise model, model cache, Hugging Face token and operation.
resource: worker-gpu/**, engines/src/eclume_engines/**, deploy/docker-compose.gpu-test.yml
tags: [worker-gpu, whisperx, gpu, benchmark, runbook]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#8, holetz/eclume#12, holetz/eclume#26, holetz/eclume#33
maintainer: holetz
---

# GPU worker on the GTX 1660 SUPER

The GPU worker (`worker-gpu/`, package `eclume_worker`) consumes the `eclume:gpu` queue and runs the
`whisperx-local` engine (`engines/`). The job contract with the server is in
[jobs-transcricao.md](/docs/standards/api/jobs-transcricao.md). The measurements below are from the host
`192.168.15.199`: GTX 1660 SUPER, 6 GB, Turing TU116 without tensor cores, driver 595.91.07, 4 CPUs.

## Compute type on the TU116

The epic's decision is `large-v3-turbo` with `compute_type=int8_float16`, and it was confirmed on the
TU116. Plain `fp16` is forbidden because of the history of NaN on the GTX 16xx series; the engine refuses it and
uses `int8_float16`, with the warning `compute_type_float16_rejected`.

- The image's CTranslate2 4.8.2 lists, for the GPU, the types `int8_float16`, `float16`,
  `float32`, `int8_float32` and `int8`.
- With `int8_float16`, 1 h of Portuguese speech came out readable and complete: 670 segments, 7,904
  words and every word timed by the alignment. There was no NaN and no empty segment.
- Since `int8_float16` did not fail, `int8` and `float32` were not measured. They remain as an automatic
  fallback, in that order, if CTranslate2 refuses the requested type.

## Benchmark

**Audio:** 1 h of real Portuguese speech — short stories by Artur Azevedo read by volunteers of
LibriVox (public domain), converted to the upload format (mono Opus 16 kHz, 32 kbps,
14.1 MB). The script `worker-gpu/scripts/make-test-audio.sh bench` reproduces it.

**How to measure:** `python -m eclume_worker.bench` inside the image, with the compose worker stopped
and the models already in the cache. The GPU had 349 MiB in use beforehand (Xorg and an idle Jellyfin), with 5,396 MiB
free. The peak VRAM is the whole device's usage minus that baseline, sampled by
NVML every 0.2 s. The time is that of the whole pipeline, including model loading.

```bash
docker --context gpu-host run --rm --gpus all -v /srv/eclume/models:/models \
  -v /srv/eclume/bench:/bench -v /srv/eclume/secrets:/run/secrets:ro \
  eclume-worker-gpu:dev python -m eclume_worker.bench /bench/bench-1h.ogg --no-diarize
```

### Without diarization (ASR `large-v3-turbo` `int8_float16` + pt wav2vec2 alignment)

| ASR batch | Processing of 1 h | Real-time factor | Min per hour of audio | Peak VRAM |
|---|---|---|---|---|
| 4 | 357 s | 0.099 | 5.95 | 2,999 MiB |
| 8 | 381 s | 0.106 | 6.35 | 2,997 MiB |
| 16 | 370 s | 0.103 | 6.16 | 3,873 MiB |

- **The batch does not change the time:** the 1660 SUPER already saturates at 4. 16 only raises the peak by ~0.9 GB.
  That is why the initial batch is 4 with at least 3.5 GB free and 2 below that
  (`initial_batch_size`), and `ECLUME_BATCH_SIZE` fixes another value if needed.
- **The ~3 GB peak with batch 4 and 8 is from alignment.** The wav2vec2 large runs in fp32, and the
  ASR model was already unloaded before it.
- **With contended memory,** a foreign process holding 2.9 GB, the batch dropped to 4 on its own and
  1 h took 355 s, with a 2.1 GB peak.
- **A short job pays for loading the models.** The 30 s of the test dialogue take ~26 s with
  diarization, almost all of it loading ASR, aligner and pyannote, because there is one resident model
  at a time. Over an hour of audio, that is ~5% of the time.

### With diarization and embeddings (pyannote `community-1`, `return_embeddings=True`)

| ASR batch | Processing of 1 h | Real-time factor | Min per hour of audio | Peak VRAM |
|---|---|---|---|---|
| 4 | 517 s | 0.144 | 8.61 | 3,003 MiB |
| 16 | 542 s | 0.151 | 9.03 | 3,873 MiB |

- **Diarization costs ~3 min per hour of audio.** With batch 4, ASR and alignment took
  ~330 s and diarization with embeddings ~180 s. It does not raise the peak, because it runs after the
  aligner leaves the GPU.
- **The speakers match the readers.** The 1 h joins five stories, and pyannote found 3
  speakers. The switches fell on the story boundaries (24:10, 36:50, 46:39, 56:09), with two
  stretches of under 1 s assigned to the neighboring speaker.
- **The embeddings are from `pyannote/wespeaker-voxceleb-resnet34-LM`,** with 256 dimensions, one
  vector per speaker in `speaker_embeddings.json`.
- **On the 30 s synthetic dialogue** (two Piper voices, `min_speakers=max_speakers=2`), the integration
  test separated the 2 speakers and alternated the lines correctly, except the first sentence ("Bom
  dia, pessoal."), assigned to the other speaker.

### ASR resident between jobs (holetz/eclume#26)

Measured on 2026-09-25 with the production image, the stack's worker idle (no model loaded) and
5,396 MiB free: the fixture `two-voices.ogg` (30.4 s), three consecutive jobs on the same engine
(`python -m eclume_worker.bench a.ogg --repeat 3`, with and without `--single-slot`). Without a Hugging Face
token on the host, diarization does not run; pyannote would be reloaded on every job in both modes,
so the difference below is the ASR load.

| Mode | Job 1 (cold) | Job 2 | Job 3 |
|---|---|---|---|
| one model at a time (`--single-slot`, the previous one) | 23.2 s | 10.4 s | 10.5 s |
| resident ASR (default) | 20.6 s | 6.1 s | 5.8 s |

From the second job on, the short job drops ~43% (≈4.5 s less per job): the aligner is still
reloaded, the ASR is not. The peak above the baseline with the resident ASR was 1,746 MiB, far from the
2,500 MiB free threshold that would make the ASR leave.

### Text quality (WER and CER)

`--reference text.txt` (UTF-8) adds to the JSON the `quality` block, with the rate, the length of the
reference and the substitutions, deletions and insertions of `wer` (words) and `cer` (characters). The
recognized text is the join of the segments. The computation is its own, in `eclume_worker.wer`, with no
dependency. It is not wired to the gate nor to `deploy/`.

```bash
python -m eclume_worker.bench /bench/bench-1h.ogg --no-diarize --reference /bench/bench-1h.txt
```

**pt-BR normalization**, the same for reference and hypothesis: Unicode NFC, lowercase, punctuation
(including typographic quotes and dashes) becomes space, the hyphen and the apostrophe between letters stay
inside the word and repeated spaces collapse. Accents are preserved, because "é" and "e"
are different words; numbers and symbols are not expanded ("10" and "dez" count as an error).
In CER, the space between words is one character. An empty reference with a non-empty hypothesis gives a null
rate (`null`), with no division by zero.

**CER memory and time.** The edit distance uses the Hirschberg algorithm: linear memory and
quadratic time. The previous full matrix spent ~37 bytes per cell and did not fit in the 15 GB host
with the 1 h reference. Measured with `/usr/bin/time -v` on `char_counts`, random text of
11 symbols with 15% swaps (worst case, no common prefix), on this station:

| Characters | Before: peak / time | After: peak / time |
| --- | --- | --- |
| 6000 | 1.39 GB / 7.4 s | 46.9 MB / 13.3 s |
| 50000 | not run (estimated at ~93 GB) | 46.5 MB / 16 min 07 s (967 s) |

The "after" peak is practically the interpreter's. The time doubles, and 50 thousand characters take about 16
minutes, once per measurement and after the ASR hour. In a tie the optimal alignment is not unique: the
split between substitutions, deletions and insertions can differ from the previous version (in the 6000 case,
798/13/20 before and 778/23/30 after), but the total of errors and the rate are identical (831).

The LibriVox reference text is not in the repository; whoever measures supplies it by path. Readers
omit or add passages, which inflates the WER: the number serves to compare configurations
(`compute_type`, fallback model, WhisperX version) on the same audio/text pair, not as an
absolute value. There is not yet a baseline WER measured on the host.

## Image

`worker-gpu/Dockerfile` is built on the host, from the repository root:

```bash
docker --context gpu-host build -t eclume-worker-gpu:dev -f worker-gpu/Dockerfile .
```

- **No `nvidia/cuda` base.** The base is `python:3.12-slim-bookworm` with `ffmpeg`, as in
  whisperx-asr-service: the torch 2.8 (cu128) and CTranslate2 wheels bring the CUDA/cuDNN
  runtime, and the NVIDIA Container Toolkit injects the driver. Turing (sm_75) is among the
  architectures of the cu128 wheels.
- **The dependencies come from `uv.lock`,** with `uv sync --package eclume-worker --extra gpu`. The
  image runs the same version that CI resolved.
- **Single stage and no triton:** ~8 GB. In a multi-stage build, the ~7 GB `.venv` would exist twice
  on the host's disk (builder cache and final layer). triton only serves
  `torch.compile`, which the worker does not use, and is removed in the same layer where it is installed.
- **The build context is filtered** by `worker-gpu/Dockerfile.dockerignore`, which BuildKit reads
  because it sits next to the Dockerfile. Only the workspace manifests and the code of `engines/` and
  `worker-gpu/` go in.
- **No models in the image.** It runs as uid 1000, the owner of `/srv/eclume`, with `HOME=/tmp`.

## Preprocessing

Before the ASR, the job treats the audio with the image's `ffmpeg` (Debian bookworm, 5.1, with `arnndn`,
`afftdn`, `loudnorm`, `silencedetect`, `atrim` and `pan`), per the configuration the admin defines in
Pré-processamento and that arrives in `options.preprocess`. The order and the rules are in the
[jobs contract](../standards/api/jobs-transcricao.md#preprocessing).

- **RNNoise model:** `cb.rnnn` (conjoined-burgers, from GregorR/rnnoise-models, trained on general
  speech with ambient noise) enters the image through `ADD --checksum`, at
  `/opt/eclume/rnnoise/cb.rnnn`, with `ECLUME_RNNOISE_MODEL` pointing to it. Without the file (dev
  outside the image), noise reduction uses `afftdn` and warns `rnnoise_model_missing`.
- **Check the image:**

  ```bash
  docker --context gpu-host run --rm --entrypoint sh eclume-worker-gpu:dev \
    -c 'test -s "$ECLUME_RNNOISE_MODEL" && ffmpeg -hide_banner -filters | grep -E "arnndn|loudnorm|silencedetect"'
  ```

- The treated audio stays only in `ECLUME_WORK_DIR` and leaves with the job; the bucket keeps the original.
- The tests (`worker-gpu/tests/test_preprocess.py`) use synthetic `lavfi` audio and run where
  `ffmpeg` exists (the host, `remote-run`); without it, they skip.

## Models and token

- **Model cache:** `/srv/eclume/models`, mounted at `/models` (`HF_HOME=/models/huggingface`,
  `TORCH_HOME=/models/torch`). The first job downloads ~3.9 GB: `large-v3-turbo` (CTranslate2), the
  pt wav2vec2 `jonatasgrosman/wav2vec2-large-xlsr-53-portuguese` and pyannote `community-1`. NLTK's
  `punkt_tab`, which alignment uses, comes embedded in the image.
- **Hugging Face token:** `/srv/eclume/secrets/hf_token` (chmod 600, owner holetz), mounted
  at `/run/secrets/hf_token`, or the `HF_TOKEN` variable. It is reread on every job, so creating or
  changing the token does not require restarting the worker. The token's account must have accepted the terms
  of `pyannote/speaker-diarization-community-1`; segmentation and embedding are in the same
  repository.
- **Check access:**

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" -L -H "Authorization: Bearer $(cat /srv/eclume/secrets/hf_token)" \
    https://huggingface.co/pyannote/speaker-diarization-community-1/resolve/main/config.yaml   # 200
  ```

- **Platform token:** the admin stores the token in Administração → Locutores, and it reaches
  each job encrypted in the `options` (`hf_token_encrypted`), taking precedence over `HF_TOKEN` and the
  file. To open it, the worker needs `ECLUME_ENCRYPTION_KEY` (or `ECLUME_SECRET_KEY`)
  **equal to the server's**; without it, the job warns `hf_token_undecryptable` and uses the environment's token.
- **Without a token or without access,** the worker transcribes and aligns with a single speaker and warns in
  `engine_info.warnings`.

## Operation

```bash
docker --context gpu-host compose -p eclume-gpu-test -f deploy/docker-compose.gpu-test.yml up -d --build --wait
remote-run . 'ECLUME_GPU_E2E=1 uv run pytest worker-gpu/tests/test_gpu_e2e.py -v -s'
docker --context gpu-host compose -p eclume-gpu-test -f deploy/docker-compose.gpu-test.yml down -v
```

| Variable | Default | What it does |
|---|---|---|
| `ECLUME_REDIS_URL` | `redis://localhost:6379/0` | Redis for the queues and progress |
| `ECLUME_S3_BUCKET`, `ECLUME_S3_ENDPOINT_URL`, `ECLUME_S3_ACCESS_KEY`, `ECLUME_S3_SECRET_KEY`, `ECLUME_S3_REGION` | `eclume`, —, —, —, `us-east-1` | bucket for audio and artifacts (MinIO) |
| `ECLUME_ENGINE` | empty | forces the process's engine (`cpu` in dev and E2E); empty, `options.engine` applies. Forced, it ignores the admin's model, compute type and batch |
| `ECLUME_DEVICE` | `cuda` | torch and CTranslate2 device |
| `ECLUME_BATCH_SIZE` | empty | fixed initial ASR batch; empty, it comes from the free VRAM |
| `ECLUME_MODEL_IDLE_SECONDS` | `300` | unloads the models after this time without a job |
| `ECLUME_RECYCLE_ON_IDLE` | `1` | after the idle unload, exits the process if torch was imported (the container comes back up without it); `0` keeps the process |
| `ECLUME_KEEP_ASR_RESIDENT` | `1` | keeps the ASR loaded between steps and between jobs; `0` goes back to one model at a time |
| `ECLUME_RESIDENT_MIN_FREE_MB` | `2500` | minimum free VRAM, with the ASR loaded, for it to stay when loading the aligner or pyannote |
| `ECLUME_JOB_TIMEOUT_SECONDS` | `21600` | limit of a job (6 h) |
| `ECLUME_WORK_DIR` | `/tmp/eclume-work` | where the audio is downloaded; cleaned at the end of the job |
| `HF_TOKEN`, `ECLUME_HF_TOKEN_FILE` | —, `/run/secrets/hf_token` | Hugging Face token (the platform's, arriving in the job, wins) |
| `ECLUME_ENCRYPTION_KEY`, `ECLUME_SECRET_KEY` | — | the same as the server's: open the HF token that arrives encrypted in the job |
| `ECLUME_REMOTE_BASE_URL`, `ECLUME_REMOTE_API_KEY`, `ECLUME_REMOTE_MODEL` | — | `openai-compatible` engine (speaches) |

- **Heartbeat.** Every 15 s the worker writes `eclume:gpu:health` (TTL 45 s) with the GPU through NVML,
  the resident model and whether a job is running; it is what Administração → Saúde shows. To check on the
  host: `redis-cli HGETALL eclume:gpu:health` in the stack's Redis. Measured on the GTX 1660 SUPER on
  2026-09-25: name, 6,144 MiB total and the production stack's VRAM (3,659 MiB) read correctly; the
  hash disappears within 45 s after a `kill` and immediately on a `docker stop`.
- **VRAM shared with Jellyfin.** There are at most two models on the GPU: the ASR, resident between
  jobs, and the one of the current step (aligner or pyannote), which leaves at the end of the job, also when a
  step fails. Before loading the
  step's one with fewer than `ECLUME_RESIDENT_MIN_FREE_MB` free — Jellyfin transcoding, for
  example —, the ASR leaves; an OOM in a step with it resident unloads it and repeats the step. After
  `ECLUME_MODEL_IDLE_SECONDS` without a job, the worker unloads everything and keeps only the CUDA context
  (~120 MiB). `python -m eclume_worker.bench <audio> --repeat 3` measures consecutive jobs on the same
  engine (`runs_s`), and `--single-slot` the one-model-at-a-time behavior.
- **Process recycling when idle.** Unloading the models returns the VRAM, but the process
  kept ~4.4 GB of anonymous memory (torch, CTranslate2, pyannote and the glibc arenas) and
  ~150 MiB of CUDA-context VRAM (measured on 2026-10-06). Therefore, right after the idle
  unload, if `torch` is in `sys.modules` and no job is running, the worker logs "reciclando o
  processo para devolver a memória" with the current RSS and sends `SIGTERM` to itself: arq stops
  taking jobs, runs the `shutdown` (removes the heartbeat) and exits; `restart: unless-stopped` brings up a new
  process that does not import torch until the next job (`healthcheck.start_period` covers the
  return). A light process, which never imported torch, does not restart. The cost is reloading the
  models on the job after the idle period, which was already the case after the unload. `MALLOC_ARENA_MAX=2` in the image and
  a 2 s `poll_delay` in arq complement it. `watchdog.sh` does not alert on this
  restart: the container only counts as bad in two consecutive rounds, and the absent heartbeat
  likewise.
- **Out of memory.** An OOM in the ASR halves the batch down to 1. If it still falls short, the model
  falls to `medium` (warning `fallback_medium`). On each step back, the previous model leaves the VRAM before
  the new attempt. When that is exhausted, the job fails with `out_of_memory`.
- **Disk.** The host has little free space. Check `df -h /` before a build, and, after
  testing, take the compose down with `down -v` and delete the old `eclume-worker-gpu` images.
