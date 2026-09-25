---
type: standard
title: Contrato de jobs de transcrição (server ↔ worker GPU)
description: As duas filas arq (`eclume:gpu` e `eclume:default`), o job `transcribe` que o server enfileira, os artefatos e os jobs `ingest_transcript`/`transcription_failed` que o worker GPU devolve, o progresso no Redis e a idempotência por `(recording_id, revision)`.
resource: server/src/eclume_server/queue.py, server/src/eclume_server/worker.py, server/src/eclume_server/transcripts.py, worker-gpu/**
tags: [api, jobs, arq, redis, worker, transcricao]
timestamp: 2026-09-24
audience: both
authority: current
source: holetz/eclume#5
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
para o estado do job.

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
