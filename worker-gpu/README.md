# eclume-worker

eclume's GPU worker (`eclume_worker`): consumes the `transcribe` job from the `eclume:gpu` arq
queue, one at a time. It downloads the audio from S3, runs the engine (`whisperx-local` by
default) and writes `transcript.raw.json` and `speaker_embeddings.json`. Then it enqueues
`ingest_transcript`, or `transcription_failed` on failure, on `eclume:default`; when the server
has written the `eclume:cancel:{id}:{revisão}` key, it stops at the next checkpoint, with no
callback. The contract is in
[docs/standards/api/jobs-transcricao.md](../docs/standards/api/jobs-transcricao.md).

```bash
arq eclume_worker.worker.WorkerSettings                        # inside the image
python -m eclume_worker.bench /bench/audio.ogg --no-diarize    # benchmark of one engine
```

- `Dockerfile`: CUDA image, built on the GPU host by `docker --context gpu-host build`.
- `scripts/make-test-audio.sh`: generates the two-voice fixture and the benchmark's 1 h audio.
- `tests/`: light tests, without torch, with fake Redis, S3 and engine. `test_gpu_e2e.py` runs only
  on the host (`ECLUME_GPU_E2E=1`).

Runbook, benchmark and environment variables are in
[docs/project/worker-gpu.md](../docs/project/worker-gpu.md). This development machine has no GPU.
