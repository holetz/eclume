---
type: standard
title: Contrato de jobs de transcrição (server ↔ worker GPU)
description: As duas filas arq (`eclume:gpu` e `eclume:default`), o job `transcribe` que o server enfileira, os artefatos e os jobs `ingest_transcript`/`transcription_failed` que o worker GPU devolve, o progresso no Redis e a idempotência por `(recording_id, revision)`.
resource: server/src/eclume_server/queue.py, server/src/eclume_server/worker.py, server/src/eclume_server/transcripts.py, worker-gpu/**
tags: [api, jobs, arq, redis, worker, transcricao]
timestamp: 2026-09-25
audience: both
authority: current
source: holetz/eclume#5, holetz/eclume#8
maintainer: holetz
---

# Contrato de jobs de transcrição (server ↔ worker GPU)

O server (`server/`, holetz/eclume#5) e o worker GPU (`worker-gpu/`, holetz/eclume#8) só se
falam por filas e pelo bucket. Este é o contrato entre os dois; nenhum lado o reinterpreta, e
mudá-lo é mudar os dois lados juntos.

## Filas

Arq sobre Redis (`ECLUME_REDIS_URL`), com duas filas:

- `eclume:gpu`, consumida só pelo `worker-gpu` com `max_jobs=1`;
- `eclume:default`, consumida pelo worker CPU do pacote `server` (`eclume_server.worker`).

## `transcribe` — o server enfileira

Enfileirar é papel do server. Quando o upload completa (ou numa retranscrição), ele chama
`transcribe` em `eclume:gpu` com `_job_id="transcribe:{recording_id}:{revision}"` e estes
argumentos:

- `recording_id: str` (UUID);
- `audio_key: str` — chave S3 do áudio, no bucket `ECLUME_S3_BUCKET`;
- `options: dict`, com `language` (padrão `"pt"`), `min_speakers`, `max_speakers`, `engine`,
  `model`, `compute_type`, `diarize: bool` e `embeddings: bool`. A configuração do admin chega por
  aqui; **o worker não lê o banco**.

## O worker GPU devolve

1. Baixa o áudio do S3, roda o pipeline e grava `recordings/{recording_id}/transcript.raw.json`
   no mesmo bucket.
2. O arquivo segue [`contracts/transcript.schema.json`](/contracts/transcript.schema.json):
   segmentos, palavras e locutores com `label` "Locutor N", **sem** `person`/`suggestions`, que
   são do server.
3. Grava também um `speaker_embeddings` com `{speaker_id: [float, ...]}` e `embedding_model`,
   num arquivo à parte: `recordings/{recording_id}/speaker_embeddings.json`.
4. Em seguida enfileira `ingest_transcript(recording_id, transcript_key, embeddings_key,
   engine_info)` em `eclume:default`. O `engine_info` traz engine, modelo, `compute_type`,
   duração, tempo real e VRAM de pico.
5. Em falha, enfileira `transcription_failed(recording_id, error_code, message)` em
   `eclume:default`.

## Progresso

O worker grava `HSET eclume:progress:{recording_id}` com `stage` (`download`, `asr`, `align`,
`diarize`, `embed` ou `upload`), `pct` (0–100) e `updated_at`, com TTL de 1 dia. O server lê
para o estado do job. O hash traz também `started_at` (RFC 3339 UTC), o início do job, gravado
desde a primeira escrita.

## O server ingere

`ingest_transcript` persiste a transcrição no Postgres, indexa para FTS e guarda os embeddings
(coluna pgvector, dimensão pelo modelo). A comparação com as pessoas é da spec
`identificacao-por-voz` (holetz/eclume#15) e não entra aqui. Depois muda o estado da gravação
para `transcribed`.

## Idempotência

Reprocessar a mesma `revision` sobrescreve os artefatos; `ingest_transcript` é idempotente por
`(recording_id, revision)`.

## Dev sem GPU

`ECLUME_ENGINE=cpu` (faster-whisper `small` int8, sem alinhamento, diarização opcional). Os testes
do server usam um worker fake que publica um `transcript.raw.json` de fixture de
`contracts/fixtures/`.

## Como o server cumpre a sua parte

- **Opções.** `options` sai da configuração da organização (`org_settings`): o idioma é o da
  gravação, sem região (`pt-BR` → `pt`), ou o padrão da organização; `diarize` é a diarização
  ligada; `embeddings` só é `true` com o opt-in de identificação por voz da organização (LGPD).
- **Revisão.** A `revision` do job é a da transcrição que ele vai produzir: 1 no primeiro;
  numa retranscrição, uma acima da maior entre a transcrição e o último job.
- **Estado do job.** Com o hash de progresso presente, o job aparece `running` e a gravação
  `processing`; `stage` vira `Job.stage` do contrato v1 (`download`/`asr` → `asr`, `align` →
  `alignment`, `diarize` → `diarization`, `embed` → `embeddings`, `upload` → `finalizing`) e
  `progress = pct / 100`. O `ingest_transcript` e o `transcription_failed` apagam o hash.
- **Ingestão tolerante.** O raw é lido com padrões para o que faltar e ignorando o que não se
  conhece; um id de locutor fora de `S<n>` é renumerado na ordem em que aparece, e o mesmo mapa
  vale para os embeddings. Com o job já `succeeded`, `ingest_transcript` não faz nada.
- **Prova.** `server/tests/test_pipeline.py` roda o ciclo com o worker GPU fake de
  `server/tests/eclume_server_testing/fakes.py` e o worker CPU real.

## Como o worker cumpre a sua parte

- **Execução.** `max_jobs=1` e `max_tries=1`. Uma falha não relança exceção: o worker enfileira
  `transcription_failed` e encerra o job, e o retry é decisão do server. A `revision` é lida do
  `_job_id`; sem ela, vale 1.
- **Engine.** `ECLUME_ENGINE`, quando definido no processo do worker, força a engine (dev sem
  GPU: `cpu`). Vazio, vale `options.engine`, e na falta dele, `whisperx-local`. A engine `cpu`
  não diariza, e o raw sai com um locutor.
- **Idioma.** A engine recebe só o idioma de `language` (`pt-BR` → `pt`), e o raw guarda o valor
  recebido.
- **Raw.** Locutores `S1..Sn` na ordem da primeira fala, `label` `Locutor N`, `talk_ms` e
  `person: null`, que o schema exige; nunca `suggestions`. Sem diarização, um locutor só (`S1`).
  O worker preenche `recording_id`, `language`, `duration_ms`, `content_hash` (sha256 do áudio
  baixado), `revision`, `engine`, `speakers` e `segments` com palavras. Os campos que só o server
  conhece (`id`, `title`, `owner`, `recorded_at`, `source`, `created_at`, `updated_at`) saem
  **provisórios**, só para o arquivo validar no schema; a ingestão os ignora.
- **Embeddings.** O arquivo é sempre gravado, com chaves nos ids do raw:
  `{"embedding_model": "pyannote/wespeaker-voxceleb-resnet34-LM", "dimension": 256,
  "speaker_embeddings": {"S1": [...]}}`. Sem diarização, `speaker_embeddings` é `{}`, e
  `embedding_model` e `dimension` são `null`.
- **Diarização degradada.** Sem token do Hugging Face, ou sem acesso ao modelo gated (termos não
  aceitos), o worker transcreve com um locutor e avisa em `engine_info.warnings`
  (`diarization_skipped_no_token`, `diarization_skipped_no_access`). Qualquer outro erro da
  diarização falha o job.
- **Progresso.** O `pct` é o geral do job e nunca recua, com uma faixa por etapa: `download`
  0–5, `asr` 5–55, `align` 55–70, `diarize` 70–90, `embed` 90–95 e `upload` 95–100. Uma etapa que
  não roda é pulada. O `pct` 100 é gravado **antes** de `ingest_transcript` ser enfileirado, para
  não recriar o hash que a ingestão apaga.

`engine_info`:

| Campo | O que é |
|---|---|
| `started_at` | início do job (RFC 3339 UTC), o mesmo do hash de progresso |
| `engine`, `model`, `compute_type`, `batch_size` | como o ASR rodou (o modelo cai para `medium` num OOM persistente) |
| `language` | idioma passado à engine |
| `duration_ms` | duração do áudio |
| `processing_ms`, `job_ms` | tempo da engine e tempo total do job, com download e upload |
| `realtime_factor` | `processing_ms / duration_ms` |
| `peak_vram_mb` | pico de VRAM acima da linha de base anterior ao job (NVML), ou `null` |
| `align_model`, `diarization_model`, `embedding_model` | modelos usados; `null` quando a etapa não rodou |
| `warnings` | avisos (`diarization_skipped_no_token`, `diarization_skipped_no_access`, `fallback_medium`, `batch_size_reduced`, `compute_type_float16_rejected`, `alignment_unavailable`) |
| `worker_version` | versão do `eclume_worker` |

`error_code` de `transcription_failed`:

| `error_code` | Quando |
|---|---|
| `audio_download_failed` | o `audio_key` não existe ou o S3 falhou |
| `audio_decode_failed` | o ffmpeg não decodifica o áudio |
| `out_of_memory` | falta VRAM mesmo com lote 1 e o modelo `medium` |
| `asr_failed` | erro no ASR que não é falta de memória |
| `alignment_failed` | erro no alinhamento por palavra |
| `diarization_failed` | erro na diarização com o modelo acessível |
| `upload_failed` | falha ao gravar os artefatos no bucket |
| `internal_error` | engine desconhecida ou mal configurada, ou erro inesperado |

A prova do lado do worker é `worker-gpu/tests/test_jobs.py` (fakes) e
`worker-gpu/tests/test_gpu_e2e.py`, que roda no host GPU contra `deploy/docker-compose.gpu-test.yml`.
