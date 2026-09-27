---
type: standard
title: Contrato de jobs de transcrição (server ↔ worker GPU)
description: As duas filas arq (`eclume:gpu` e `eclume:default`), o job `transcribe` que o server enfileira (com a configuração do admin, o pré-processamento e o token do HF cifrado nas options), o pré-processamento do áudio com ffmpeg antes do ASR, os artefatos e os jobs `ingest_transcript`/`transcription_failed` que o worker GPU devolve, o progresso e o heartbeat no Redis, a idempotência por `(recording_id, revision)`, a detecção de job morto pelo server e o ASR residente entre jobs.
resource: server/src/eclume_server/queue.py, server/src/eclume_server/worker.py, server/src/eclume_server/transcripts.py, worker-gpu/**
tags: [api, jobs, arq, redis, worker, transcricao]
timestamp: 2026-09-27
audience: both
authority: current
source: holetz/eclume#5, holetz/eclume#8, holetz/eclume#12, holetz/eclume#15, holetz/eclume#26, holetz/eclume#32, holetz/eclume#33
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
- Acrescentados pela holetz/eclume#12 (aditivos: um worker antigo os ignora), todos opcionais:
  - `batch_size` — lote inicial do ASR; `ECLUME_BATCH_SIZE` do worker vence;
  - `fallback_model` — modelo depois de um OOM persistente (padrão `medium`);
  - `diarization_model` — pipeline de diarização (padrão `pyannote/speaker-diarization-community-1`);
  - `endpoint_url` — base da engine `openai-compatible`; vence `ECLUME_REMOTE_BASE_URL`;
  - `hf_token_encrypted` — o token do Hugging Face da plataforma (`platform_secrets`), cifrado. Vai só no payload
    enfileirado, nunca em `transcription_jobs.options`. Formato: `v1:` + base64(nonce de 12 bytes +
    cifra AES-256-GCM + tag), com a chave de `ECLUME_ENCRYPTION_KEY` (base64 de 32 bytes) ou, sem
    ela, HKDF-SHA256 de `ECLUME_SECRET_KEY` com `info=eclume-secrets-v1` — **as mesmas no server
    e no worker**. Vence `HF_TOKEN` e o arquivo; se não abrir, o job segue com o token do ambiente e
    o aviso `hf_token_undecryptable`.
- Acrescentados pela holetz/eclume#33 (aditivos, opcionais):
  - `language: null` — o idioma automático (`asr.default_language: "auto"`): a engine detecta, o
    alinhador segue o detectado e o raw guarda o detectado. Sem a chave (job antigo), vale `pt`;
  - `preprocess` — o bloco `preprocessing` da plataforma (`denoise`, `loudnorm`, `trim_silence`,
    `split_channels`), que o worker aplica antes do ASR. Sem ele, o worker só converte o formato.

## Pré-processamento

`eclume_worker/preprocess.py`, entre o download e o ASR, com o `ffmpeg` da imagem, numa thread.
A ordem é fixa:

1. **Sonda** (`ffprobe`): os canais do áudio.
2. **Separar canais** (ligado e só com 2 canais): `pan=mono|c0=c0-c1,volumedetect` com
   `mean_volume` abaixo de −60 dB é mono duplicado, e a etapa sai `skipped` (`dual_mono`); senão,
   cada canal é uma entrada (`pan=mono|c0=c0` e `pan=mono|c0=c1`). Sem separação, a entrada é a
   mistura (`aformat=channel_layouts=mono`).
3. **Cadeia de render**, uma passada por entrada: `aresample=48000` (o RNNoise exige 48 kHz);
   redução de ruído `arnndn=m=$ECLUME_RNNOISE_MODEL:mix=<strength>` ou
   `afftdn=nr=<6 + 24·strength>:nf=-50`; `loudnorm=I:TP:LRA` (depois do ruído, para não
   amplificá-lo); `aresample=16000`; saída `-ac 1 -ar 16000 pcm_s16le`.
4. **Cortar silêncio** (ligado): `silencedetect` no arquivo já normalizado; um silêncio que começa
   no início define o começo da fala, e um que vai até o fim define o fim. Com canais separados,
   vale o menor começo e o maior fim, e o mesmo `atrim` corta os dois. Silêncios no meio ficam.
5. **Falha:** a cadeia com código ≠ 0 cai para só o formato (`aresample=16000`, mono), com as
   etapas `failed` e o aviso `preprocess_failed`, e a transcrição segue. Se nem o formato sai,
   `audio_decode_failed`. Sem o arquivo do modelo RNNoise (dev, CI), usa `afftdn` com o aviso
   `rnnoise_model_missing`.

O áudio tratado vive só no diretório de trabalho: o bucket guarda o original, que o usuário ouve.
O **deslocamento** do corte (`offset_ms`) é somado a todo `start_ms`/`end_ms` de segmento e palavra
do raw e à `duration_ms`: as marcas de tempo são as do áudio original.

**Canais separados no ASR:** a engine roda uma vez por canal com `min_speakers = max_speakers = 1`
(o que mantém o embedding do locutor para a identificação por voz); as falas de cada canal ganham
um rótulo próprio, os segmentos se mesclam pelo início e os locutores viram `S1`, `S2` na ordem da
primeira fala. A engine não muda.

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
5. Em falha, enfileira `transcription_failed(recording_id, error_code, message, stage)` em
   `eclume:default`. `stage` é a última etapa do progresso (`preprocess`, `asr`…), que o server usa
   para marcar a etapa certa do pipeline; um worker antigo não o manda, e vale a transcrição.

## Progresso

O worker grava `HSET eclume:progress:{recording_id}` com `stage` (`download`, `preprocess`, `asr`,
`align`, `diarize`, `embed` ou `upload`), `pct` (0–100) e `updated_at`, com TTL de 1 dia. O server lê
para o estado do job. O hash traz também `started_at` (RFC 3339 UTC), o início do job, gravado
desde a primeira escrita.

## Heartbeat do worker GPU

Acrescentado pela holetz/eclume#12. A cada 15 s o worker **substitui** o hash
`eclume:gpu:health` (`DEL` + `HSET` + `EXPIRE 45`, numa transação) e o apaga no desligamento.
Hash ausente = worker parado há mais de 45 s. Campos, todos texto:

| Campo | O que é |
|---|---|
| `updated_at` | instante do heartbeat (RFC 3339 UTC) |
| `worker_version`, `engine`, `device` | versão do `eclume_worker`, engine do processo (a forçada por `ECLUME_ENGINE`, a última usada ou `whisperx-local`) e dispositivo |
| `busy` | `1` com um job rodando, `0` ocioso |
| `models` | JSON `[{name, kind, loaded_at, vram_mb}]` do modelo residente (`kind` em `asr`, `alignment`, `diarization`); `[]` sem modelo |
| `gpu_name`, `vram_total_mb`, `vram_used_mb`, `utilization_pct` | leitura da NVML do dispositivo inteiro; ausentes sem NVML (engine `cpu`) |

O `vram_mb` do modelo é o uso do dispositivo depois de carregá-lo menos o de antes. O server lê o
hash para `GET /api/v1/admin/health` ([server-admin.md](../code/server-admin.md)).

## O server ingere

`ingest_transcript` persiste a transcrição no Postgres, indexa para FTS e guarda os embeddings
(coluna pgvector, dimensão pelo modelo). Na mesma transação, restaura os vínculos
locutor↔pessoa de uma retranscrição e compara os locutores com as impressões de voz das pessoas
com consentimento, gravando as sugestões acima do limiar
([identificacao-por-voz.md](/docs/standards/code/identificacao-por-voz.md)). Depois muda o estado
da gravação para `transcribed`.

## Idempotência

Reprocessar a mesma `revision` sobrescreve os artefatos; `ingest_transcript` é idempotente por
`(recording_id, revision)`.

## Job morto

Com `max_tries=1`, um worker GPU que morre no meio do `transcribe` (OOM kill, restart, deploy)
não enfileira `transcription_failed`. O server percebe sozinho: o cron `reap_stalled_jobs` do
worker CPU (`eclume_server/stalled.py`, a cada minuto, `unique`) examina os jobs `queued`/`running`
enfileirados há mais de `ECLUME_JOB_GRACE_SECONDS` (120 s) e cruza o estado do job no arq, o hash
de progresso e o heartbeat:

| Situação | Veredito |
|---|---|
| no arq `queued`/`deferred` (fila atrasada) | nada — fila não é falha |
| arq `complete` com sucesso (a ingestão pode estar na fila `eclume:default`) | nada |
| arq `complete` com falha (o retry do arq encerrou o job de um worker morto) | `worker_lost` |
| sumido do arq (`not_found`) e sem hash de progresso | `job_lost` |
| progresso sem escrita há mais de `ECLUME_JOB_STALL_SECONDS` (1800 s), mesmo com worker vivo | `job_stalled` |
| heartbeat ausente ou `busy=0` e progresso ausente ou sem escrita há mais que a graça | `worker_lost` |

- **Duas observações.** Nada é marcado na primeira vez: a suspeita fica em
  `eclume:reaper:suspect:<_job_id>` (código e instante) e só vira falha se o mesmo diagnóstico
  durar a graça inteira. Isso cobre o worker que acabou de pegar o job e ainda não publicou
  progresso nem heartbeat.
- **Falha recuperável.** O veredito vai pelo mesmo `fail()` do `transcription_failed` (job e
  gravação `failed`, hash apagado), com mensagem em pt-BR. `worker_lost`, `job_lost`,
  `job_stalled`, `gpu_oom`, `out_of_memory`, `audio_download_failed` e `upload_failed` saem com
  `Job.error.retryable = true` (contrato 1.4.0).
- **Retentar é explícito.** O dono retranscreve (`POST /recordings/{id}/retranscribe`); o admin
  retenta a gravação de qualquer usuário por `POST /admin/jobs/{job_id}/retry`
  ([server-admin.md](../code/server-admin.md)). Os dois criam a revisão seguinte com a
  configuração atual. Não há retentativa automática: repetiria um OOM ou um áudio ruim em laço.
- **Prova.** `server/tests/test_stalled.py`, um teste por linha da tabela.

## Dev sem GPU

`ECLUME_ENGINE=cpu` (faster-whisper `small` int8, sem alinhamento, diarização opcional). Os testes
do server usam um worker fake que publica um `transcript.raw.json` de fixture de
`contracts/fixtures/`.

## Como o server cumpre a sua parte

- **Opções.** `options` sai da configuração da plataforma (`platform_settings`): o idioma é o da
  gravação, sem região (`pt-BR` → `pt`), ou o padrão da plataforma; `diarize` é a diarização
  ligada; `embeddings` só é `true` com a identificação por voz ligada na plataforma (LGPD).
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
  GPU e o E2E: `cpu`). Vazio, vale `options.engine`, e na falta dele, `whisperx-local`. Uma engine
  forçada diferente de `options.engine` ignora `model`, `compute_type`, `batch_size` e
  `fallback_model` do job — são da engine que o admin escolheu — e usa os padrões dela. A engine
  `cpu` não diariza, e o raw sai com um locutor.
- **ASR residente.** Na `whisperx-local`, o ASR fica carregado entre jobs, ao lado de um lugar
  para o modelo da etapa (alinhamento ou diarização). Antes de carregar o modelo de uma etapa com
  menos de `ECLUME_RESIDENT_MIN_FREE_MB` (2500) livres, o ASR sai; um OOM numa etapa com o ASR
  residente o descarrega e repete a etapa uma vez. No fim do job, o modelo da etapa sai e o ASR
  fica até a descarga por ociosidade (`ECLUME_MODEL_IDLE_SECONDS`, 300 s).
  `ECLUME_KEEP_ASR_RESIDENT=0` volta a um modelo por vez. O heartbeat declara os residentes.
- **Idioma.** A engine recebe só o idioma de `language` (`pt-BR` → `pt`), e o raw guarda o valor
  recebido; com `language: null`, a engine detecta e o raw guarda o detectado.
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
  0–3, `preprocess` 3–10, `asr` 10–55, `align` 55–70, `diarize` 70–90, `embed` 90–95 e `upload` 95–100. Uma etapa que
  não roda é pulada. O `pct` 100 é gravado **antes** de `ingest_transcript` ser enfileirado, para
  não recriar o hash que a ingestão apaga.

`engine_info`:

| Campo | O que é |
|---|---|
| `started_at` | início do job (RFC 3339 UTC), o mesmo do hash de progresso |
| `preprocess` | `{steps: [{step, state, params?, reason?, error?}], ms, offset_ms, channels, split, fallback, warnings, ffmpeg_version}`: o que o pré-processamento fez |
| `engine`, `model`, `compute_type`, `batch_size` | como o ASR rodou (o modelo cai para `medium` num OOM persistente) |
| `language` | idioma passado à engine, ou o detectado com o idioma automático |
| `duration_ms` | duração do áudio |
| `processing_ms`, `job_ms` | tempo da engine e tempo total do job, com download e upload |
| `realtime_factor` | `processing_ms / duration_ms` |
| `peak_vram_mb` | pico de VRAM acima da linha de base anterior ao job (NVML), ou `null` |
| `align_model`, `diarization_model`, `embedding_model` | modelos usados; `null` quando a etapa não rodou |
| `warnings` | avisos (`diarization_skipped_no_token`, `diarization_skipped_no_access`, `fallback_medium` — também com outro `fallback_model` —, `batch_size_reduced`, `compute_type_float16_rejected`, `alignment_unavailable`, `hf_token_undecryptable`, `preprocess_failed`, `rnnoise_model_missing`) |
| `worker_version` | versão do `eclume_worker` |

`error_code` de `transcription_failed`:

| `error_code` | Quando |
|---|---|
| `audio_download_failed` | o `audio_key` não existe ou o S3 falhou |
| `audio_decode_failed` | o ffmpeg não decodifica o áudio, nem para só converter o formato |
| `out_of_memory` | falta VRAM mesmo com lote 1 e o modelo `medium` |
| `asr_failed` | erro no ASR que não é falta de memória |
| `alignment_failed` | erro no alinhamento por palavra |
| `diarization_failed` | erro na diarização com o modelo acessível |
| `upload_failed` | falha ao gravar os artefatos no bucket |
| `internal_error` | engine desconhecida ou mal configurada, ou erro inesperado |

A prova do lado do worker é `worker-gpu/tests/test_jobs.py` (fakes) e
`worker-gpu/tests/test_gpu_e2e.py`, que roda no host GPU contra `deploy/docker-compose.gpu-test.yml`.
