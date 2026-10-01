# eclume-worker

Worker GPU do eclume (`eclume_worker`): consome o job `transcribe` da fila arq `eclume:gpu`, um
por vez. Ele baixa o áudio do S3, roda a engine (`whisperx-local` por padrão) e grava
`transcript.raw.json` e `speaker_embeddings.json`. Depois enfileira `ingest_transcript`, ou
`transcription_failed` em falha, em `eclume:default`; com a chave `eclume:cancel:{id}:{revisão}`
gravada pelo server, para no próximo ponto de checagem, sem retorno. O contrato está em
[docs/standards/api/jobs-transcricao.md](../docs/standards/api/jobs-transcricao.md).

```bash
arq eclume_worker.worker.WorkerSettings                        # dentro da imagem
python -m eclume_worker.bench /bench/audio.ogg --no-diarize    # benchmark de uma engine
```

- `Dockerfile`: imagem CUDA, construída no host GPU por `docker --context gpu-host build`.
- `scripts/make-test-audio.sh`: gera a fixture de duas vozes e o áudio de 1 h do benchmark.
- `tests/`: testes leves, sem torch, com Redis, S3 e engine fakes. `test_gpu_e2e.py` roda só no
  host (`ECLUME_GPU_E2E=1`).

Runbook, benchmark e variáveis de ambiente estão em
[docs/project/worker-gpu.md](../docs/project/worker-gpu.md). Esta máquina de desenvolvimento não
tem GPU.
