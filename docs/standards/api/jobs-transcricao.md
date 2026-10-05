---
type: standard
title: Contrato de jobs de transcrição (server ↔ worker GPU)
description: As filas arq (`eclume:gpu` e `eclume:default`), o job `transcribe` que o server enfileira (com a configuração do admin, o pré-processamento e o token do HF cifrado nas options), o pré-processamento do áudio com ffmpeg antes do ASR, os artefatos por revisão e os jobs `ingest_transcript`/`transcription_failed` que o worker GPU devolve com a revisão no `_job_id`, o progresso e o heartbeat no Redis, a idempotência por `(recording_id, revision)`, a retentativa da falha passageira nos retornos, a detecção de job morto pelo server, o ASR residente entre jobs, a serialização JSON sem pickle irrestrito e a lista permitida de contêineres com `-protocol_whitelist` e tempo limite no ffmpeg, e a espera na fila (`Job.queue`) com o último visto do processador e a estimativa pelo histórico.
resource: engines/src/eclume_engines/fila.py, server/src/eclume_server/queue.py, server/src/eclume_server/queue_status.py, server/src/eclume_server/dispatch.py, server/src/eclume_server/worker.py, server/src/eclume_server/transcripts.py, worker-gpu/**
tags: [api, jobs, arq, redis, worker, transcricao]
timestamp: 2026-10-05
audience: both
authority: current
source: holetz/eclume#5, holetz/eclume#8, holetz/eclume#12, holetz/eclume#15, holetz/eclume#26, holetz/eclume#32, holetz/eclume#33, holetz/eclume#95, holetz/eclume#96, holetz/eclume#97, holetz/eclume#92, holetz/eclume#94, holetz/eclume#93, holetz/eclume#126, holetz/eclume#98, holetz/eclume#117, holetz/eclume#121, holetz/eclume#142
maintainer: holetz
---

# Contrato de jobs de transcrição (server ↔ worker GPU)

O server (`server/`, holetz/eclume#5) e o worker GPU (`worker-gpu/`, holetz/eclume#8) só se
falam por filas e pelo bucket. Este é o contrato entre os dois; nenhum lado o reinterpreta, e
mudá-lo é mudar os dois lados juntos.

## Filas

Arq sobre Redis (`ECLUME_REDIS_URL`), com três filas (holetz/eclume#96):

- `eclume:gpu`, consumida só pelo `worker-gpu` com `max_jobs=1`;
- `eclume:default`, consumida pelo worker CPU do pacote `server` (`WorkerSettings`, `max_jobs`
  explícito): `ingest_transcript`, `transcription_failed`, `purge_embedding_objects` e todos os
  crons (reaper, retomada, uploads vencidos);
- `eclume:agents`, consumida pelo worker de agentes (`AgentWorkerSettings`, serviço
  `worker-agents`, `max_jobs = ECLUME_AGENT_MAX_JOBS`, padrão 4): `detect_agenda_type`,
  `fill_fields`, `summarize`, `summary_chat`, `base_chat`, `agent_turn` (o Agente) e `run_preview`. A ingestão não divide
  vaga com chamada a agente. Na transição, o worker de `eclume:default` mantém as funções de agente
  registradas por uma versão, para drenar o que já estava na fila dele.

O worker GPU não muda de fila: os retornos continuam em `eclume:default`.

**Despacho na vez da conta (holetz/eclume#98).** A fila da GPU é justa sem mexer no arq: cada conta
tem no máximo um `transcribe` em `eclume:gpu`. O job nasce `queued` sem
`transcription_jobs.dispatched_at` — retido no banco — e `dispatch.next_for(owner)` o despacha:
numa transação com `pg_advisory_xact_lock` da conta, se ela não tem job despachado em aberto e está
dentro dos minutos de áudio de 24 h (`quotas.gpu_minutes_24h`, soma de `recordings.duration_ms` dos
jobs despachados na janela), marca `dispatched_at` no retido mais antigo e o enfileira depois do
commit, com o `_job_id` `transcribe:{recording_id}:{revision}`. Com um job por conta na fila FIFO do
arq, o rodízio entre contas sai sozinho: dez arquivos de uma pessoa não atrasam o primeiro de
outra. Despacham: o `complete` do upload, retranscrever, a retentativa do admin, `ingest_transcript`
e `transcription_failed` (a GPU ficou livre para a conta) e o cron `dispatch_transcriptions` do
worker CPU (a cada minuto, `unique`), rede para o que nenhum desses cobre — reaper, cancelamento,
exclusão e a janela de minutos que reabre. A conta que passou dos minutos não perde nada: a
gravação espera retida até a janela abrir. O worker GPU não lê o banco e não sabe do despacho.

**Serialização (holetz/eclume#94).** Nenhum job nem resultado é desserializado com `pickle`
irrestrito: `eclume_engines.fila` tem `serializar` (JSON, `default=str`, que nunca falha) e
`desserializar` (JSON; bytes com o marcador de protocolo do pickle passam por um `Unpickler` cujo
`find_class` recusa toda classe, então só tipos primitivos abrem). Todo leitor usa o
`desserializar`: o pool do server (`job_deserializer`), o `WorkerSettings` dos workers CPU e GPU e o
`Job` do reaper. A troca é em duas fases (expandir/contrair): na fase A, só os leitores mudam e o
serializador continua pickle; depois do deploy dela, a fase B passa `serializar` como
`job_serializer` em todo produtor e worker. Assim, nenhum leitor antigo recebe JSON e nenhum job na
fila se perde. Argumento de job é sempre `str`, `int`, `float`, `bool`, `None`, `dict` ou `list`.

## Cancelamento

Cooperativo, por chave no Redis — não `Job.abort()`, que cancela a task mas deixa o ASR rodando
na thread e libera a vaga de `max_jobs=1` com a GPU ainda ocupada.

- **Quem cancela.** `POST /api/v1/recordings/{id}/cancel` (o dono, `recordings:write`; 409 sem
  job `queued`/`running`), a exclusão da gravação (API, web e MCP) e a exclusão da conta. Numa
  transação, travando a gravação antes de ler o job: job `cancelled` com `finished_at` e
  `error_code` `cancelled` (recuperável), gravação `failed` e a etapa em curso — o
  pré-processamento, se o progresso da revisão está em `download` ou `preprocess`; senão, a
  transcrição — `skipped` com o motivo `cancelled`. Retranscrever é a volta.
- **A chave.** Depois do commit, o server grava `eclume:cancel:{recording_id}:{revision}` (TTL 7
  dias). Se a gravação falhar, só custa GPU: o resultado chega obsoleto e é descartado.
- **O worker.** Confere a chave ao pegar o job (antes do download) e a cada ~5 s enquanto ele roda,
  ligando um `threading.Event`; a callback de progresso, na thread da engine, levanta a interrupção
  no próximo lote do ASR ou da diarização, e há checagem entre download, pré-processamento, ASR e
  upload. O alinhamento e as passadas do ffmpeg não têm ponto de checagem: o pedido vale ao fim
  deles. Cancelado, o job não enfileira retorno, apaga o hash de progresso e o diretório de
  trabalho e só então libera a vaga. Um worker antigo ignora a chave e só deixa de cancelar.

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

0. **Contêiner pela lista permitida** (holetz/eclume#94): os bytes iniciais do arquivo escolhem o
   demuxer — `OggS` → `ogg`; EBML `1A45DFA3` → `matroska` (Matroska e WebM); `ftyp` na posição 4 →
   `mov` (MP4, MOV, M4A); `RIFF…WAVE` → `wav`; `fLaC` → `flac`; `ID3` ou sincronia MPEG → `mp3`;
   cabeçalho ADTS → `aac`. O ffmpeg nunca adivinha o formato: todo `ffprobe`/`ffmpeg` recebe `-f`
   explícito, `-protocol_whitelist file` e a entrada como `file:<caminho>`, inclusive nos WAV
   intermediários. Playlist HLS, `concat`, SDP e qualquer outro contêiner terminam em
   `audio_decode_failed` com o motivo (`contêiner fora da lista permitida`), sem chamar o ffmpeg.
   **Tempo limite:** 60 s no `ffprobe`; em cada `ffmpeg`, 300 s mais a duração do áudio, com teto
   de 4 h (o teto também vale quando a duração é desconhecida). Estourar o tempo é uma falha como
   outra (cai no passo 5). O WhisperX só recebe o WAV que o próprio pré-processamento gerou.
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
do raw: as marcas de tempo são as do áudio original. A `duration_ms` do raw é a do original (pelo
`ffprobe`), com os silêncios cortados. O corte vale para todos os canais ou para nenhum: cada canal
é cortado num temporário, e a troca acontece só quando todos saíram.

**Canais separados no ASR:** a engine roda uma vez por canal com `min_speakers = max_speakers = 1`
(o que mantém o embedding do locutor para a identificação por voz); as falas de cada canal ganham
um rótulo próprio, os segmentos se mesclam pelo início e os locutores viram `S1`, `S2` na ordem da
primeira fala. A engine não muda.

## O worker GPU devolve

1. Baixa o áudio do S3, roda o pipeline e grava `recordings/{recording_id}/r{revision}/transcript.raw.json`
   no mesmo bucket (a `revision` é a do `_job_id` do `transcribe`).
2. O arquivo segue [`contracts/transcript.schema.json`](/contracts/transcript.schema.json):
   segmentos, palavras e locutores com `label` "Locutor N", **sem** `person`/`suggestions`, que
   são do server.
3. Grava também um `speaker_embeddings` com `{speaker_id: [float, ...]}` e `embedding_model`,
   num arquivo à parte: `recordings/{recording_id}/r{revision}/speaker_embeddings.json`. O server
   o põe na fila de exclusão do bucket na transação da ingestão, guardado ou descartado o vetor:
   a biometria vive só no banco (holetz/eclume#97).
4. Em seguida enfileira `ingest_transcript(recording_id, transcript_key, embeddings_key,
   engine_info)` em `eclume:default`, com `_job_id="ingest_transcript:{recording_id}:{revision}"`.
   O `engine_info` traz engine, modelo, `compute_type`, duração, tempo real e VRAM de pico.
5. Em falha, enfileira `transcription_failed(recording_id, error_code, message, stage)` em
   `eclume:default`, com `_job_id="transcription_failed:{recording_id}:{revision}"`. `stage` é a
   última etapa do progresso (`preprocess`, `asr`…), que o server usa para marcar a etapa certa do
   pipeline; um worker antigo não o manda, e vale a transcrição.

A revisão viaja só no `_job_id` (holetz/eclume#95): os argumentos posicionais não mudam, e um
server antigo ingere o retorno do worker novo. O server lê a revisão exigindo o prefixo
`{job}:{recording_id}:` e um inteiro ≥ 1; sem isso (worker antigo, id sorteado pelo arq), vale a
regra antiga, o job mais recente da gravação, e as chaves que o job traz (inclusive as antigas, sem
`r{revision}/`). O mesmo `_job_id` deduplica o retorno repetido da mesma revisão.

## Progresso

O worker grava `HSET eclume:progress:{recording_id}` com `revision`, `stage` (`download`,
`preprocess`, `asr`, `align`, `diarize`, `embed` ou `upload`), `pct` (0–100) e `updated_at`, com TTL
de 1 dia. O server lê para o estado do job. O hash traz também `started_at` (RFC 3339 UTC), o início
do job, gravado desde a primeira escrita.

`transcription_jobs.started_at` é o início real do job no worker GPU (holetz/eclume#93): no
sucesso, o `engine_info.started_at` do `ingest_transcript`; na falha, o `started_at` do hash de
progresso lido pelo `transcription_failed` (nunca depois do fim). Sem nenhum dos dois, fica o já
gravado ou a entrada na fila. As durações do pré-processamento e da transcrição partem desse início,
sem a espera na fila.

O `revision` (holetz/eclume#95) diz de qual revisão é o progresso: a tela da gravação, a Saúde do
admin e o reaper só usam o hash cuja revisão é a do job em aberto; o hash sem o campo (worker
antigo) vale. A chave não muda, para o server novo ver o progresso do worker antigo.

## Heartbeat do worker GPU

Acrescentado pela holetz/eclume#12. A cada 15 s o worker **substitui** o hash
`eclume:gpu:health` (`DEL` + `HSET` + `EXPIRE 45`, numa transação) e o apaga no desligamento.
Hash ausente = worker parado há mais de 45 s. Campos, todos texto:

| Campo | O que é |
|---|---|
| `updated_at` | instante do heartbeat (RFC 3339 UTC) |
| `worker_version`, `engine`, `device` | versão do `eclume_worker`, engine do processo (a forçada por `ECLUME_ENGINE`, a última usada ou `whisperx-local`) e dispositivo |
| `busy` | `1` do início ao fim de um `transcribe` (download, pré-processamento, ASR, upload e o enfileiramento do retorno), `0` ocioso |
| `job_id` | o `_job_id` do `transcribe` em curso (`transcribe:{recording_id}:{revision}`); ausente quando ocioso e no worker antigo |
| `models` | JSON `[{name, kind, loaded_at, vram_mb}]` do modelo residente (`kind` em `asr`, `alignment`, `diarization`); `[]` sem modelo |
| `gpu_name`, `vram_total_mb`, `vram_used_mb`, `utilization_pct` | leitura da NVML do dispositivo inteiro; ausentes sem NVML (engine `cpu`) |

O `vram_mb` do modelo é o uso do dispositivo depois de carregá-lo menos o de antes. O server lê o
hash para `GET /api/v1/admin/health` ([server-admin.md](../code/server-admin.md)).

**Último visto.** O cron `reap_stalled_jobs` (a cada minuto) grava em `eclume:gpu:last_seen` o
`updated_at` do heartbeat presente, antes de olhar os jobs e mesmo sem job aberto. Com o hash
ausente, esse valor é o "fora do ar desde" da espera na fila (precisão de 1 min); sem ele, nunca
houve heartbeat. Nada muda no worker GPU.

## O server ingere

`ingest_transcript` persiste a transcrição no Postgres, indexa para FTS e guarda os embeddings
(coluna pgvector, dimensão pelo modelo). Na mesma transação, restaura os vínculos
locutor↔pessoa de uma retranscrição e compara os locutores com as impressões de voz das pessoas
do diretório da conta (com a identificação por voz ligada na plataforma), gravando as sugestões
acima do limiar
([identificacao-por-voz.md](/docs/standards/code/identificacao-por-voz.md)). Depois muda o estado
da gravação para `transcribed`.

- **Embedding não finito.** A ingestão também descarta o vetor com NaN ou infinito (worker antigo,
  arquivo já no bucket): o pgvector o recusaria e desfaria a ingestão inteira.
- **Só o job da revisão da mensagem.** `ingest_transcript` e `transcription_failed` fecham só o job
  `(recording_id, revision)` da mensagem. Se esse job não está `queued`/`running` — já ingerido,
  falho pelo reaper, ou de uma revisão anterior a uma retranscrição —, a mensagem é obsoleta: é
  logada e ignorada, sem gravar transcrição, sem marcar falha, sem tocar no hash de progresso nem
  nos artefatos. Só quem fecha o job apaga o hash.
- **Falha passageira retenta.** Conexão recusada, caída ou com timeout com o Postgres ou o S3
  (família `ConnectionError`/`TimeoutError`, `socket.gaierror`, `botocore` de conexão e timeout,
  `ClientError` HTTP ≥ 500 ou `SlowDown`), pool esgotado, `OperationalError`/`InterfaceError` ou
  `DBAPIError` com `connection_invalidated`, deadlock e falha de serialização — na exceção ou na
  causa (`__cause__`, `orig`) — voltam à fila por `Retry`, levantado fora da transação, com as
  esperas `INGEST_RETRY_DELAYS_S = (15, 60, 240)` s; as duas funções são registradas com
  `max_tries=4`. As esperas somam 315 s, abaixo de `ECLUME_JOB_STALL_SECONDS`, e o reaper não
  decide no meio delas. Classificação em `eclume_server/transient.py`.
- **Ingestão que falha.** Qualquer exceção desfaz a transação inteira (nem transcrição nem etapas
  do worker GPU ficam). A definitiva — dado inválido, JSON malformado, `NoSuchKey`, violação de
  integridade —, ou a passageira na quarta tentativa, faz `ingest_transcript` marcar, numa
  transação nova, o job da revisão e a gravação com o `fail()` de sempre, código `ingest_failed`
  (recuperável), e logar a exceção. Retranscrever resolve. O `transcription_failed` que esgota as
  tentativas relança, e o reaper cobre o job.

## Idempotência

Reprocessar a mesma `revision` sobrescreve os artefatos de `r{revision}/`; `ingest_transcript` é
idempotente por `(recording_id, revision)`.

**Uma revisão guardada.** Depois do commit da ingestão que grava a revisão N, o server apaga sob
`recordings/{recording_id}/` tudo o que não está em `r{N}/`, inclusive as chaves antigas sem
revisão. Uma falha nessa limpeza só vai para o log; o resto sai na próxima ingestão ou na exclusão
da gravação, que apaga o prefixo inteiro. Guardar todas as revisões multiplicaria cópias de dado
biométrico (LGPD) sem consumidor.

## Job morto

Com `max_tries=1`, um worker GPU que morre no meio do `transcribe` (OOM kill, restart, deploy)
não enfileira `transcription_failed`. O server percebe sozinho: o cron `reap_stalled_jobs` do
worker CPU (`eclume_server/stalled.py`, a cada minuto, `unique`) examina os jobs `queued`/`running`
**despachados** há mais de `ECLUME_JOB_GRACE_SECONDS` (120 s) e cruza o estado do job no arq, o hash
de progresso e o heartbeat:

| Situação | Veredito |
|---|---|
| retido no banco, sem `dispatched_at` (aguarda a vez da conta ou a janela de minutos) | nada — não está no arq, não é job morto |
| no arq `queued`/`deferred` (fila atrasada) | nada — fila não é falha |
| arq `complete` com sucesso há até `ECLUME_JOB_STALL_SECONDS` (a ingestão pode estar na fila `eclume:default`) | nada |
| arq `complete` com sucesso há mais de `ECLUME_JOB_STALL_SECONDS` e o job ainda aberto no banco (a ingestão se perdeu) | `ingest_failed` |
| arq `complete` com falha (o retry do arq encerrou o job de um worker morto) | `worker_lost` |
| `queued` no banco, sumido do arq (`not_found`) e sem hash de progresso, pela primeira vez | reenfileirado com o mesmo `_job_id`, as `options` do job e o token do HF cifrado; marca `eclume:reaper:requeued:<_job_id>` (7 dias) |
| sumido do arq (`not_found`) e sem hash de progresso, com a marca (ou já `running`) | `job_lost` |
| progresso sem escrita há mais de `ECLUME_JOB_STALL_SECONDS` (1800 s), mesmo com worker vivo | `job_stalled` |
| o worker não está neste job (heartbeat ausente, `busy=0`, ou `job_id` de outro `transcribe`) e o progresso da revisão ausente ou sem escrita há mais que a graça | `worker_lost` |

O worker está "neste job" com heartbeat presente, `busy=1` e `job_id` igual a
`transcribe:{recording_id}:{revision}` (ou sem `job_id`, worker antigo). O hash de progresso de
outra revisão conta como ausente. O heartbeat é o sinal de vida; o progresso mede travamento.

- **Deploy drena, não mata.** O `WorkerSettings` do GPU tem `job_completion_wait = job_timeout`:
  no SIGTERM o arq para de pegar jobs e termina o atual, e os jobs na fila `eclume:gpu` seguem
  para o worker novo. O `deploy.sh` lê `busy` no heartbeat e, com a GPU ocupada, espera até
  `--espera-gpu` (30 min) antes de recriar o `worker-gpu` (`stop_grace_period: 40m`); ao fim da
  espera recusa, salvo `--interromper-gpu`. Sem essa flag, um deploy não produz `worker_lost`.
- **Duas observações.** Nada é marcado na primeira vez: a suspeita fica em
  `eclume:reaper:suspect:<_job_id>` (código e instante) e só vira falha se o mesmo diagnóstico
  durar a graça inteira. Isso cobre o worker que acabou de pegar o job e ainda não publicou
  progresso nem heartbeat.
- **Falha recuperável.** O veredito vai pelo mesmo `fail()` do `transcription_failed`, com a
  revisão da linha (job e gravação `failed`, hash apagado), com mensagem em pt-BR. `worker_lost`, `job_lost`,
  `job_stalled`, `ingest_failed`, `gpu_oom`, `out_of_memory`, `audio_download_failed` e
  `upload_failed` saem com `Job.error.retryable = true` (contrato 1.4.0; `ingest_failed` desde a
  2.5.0). A ingestão que falha
  com exceção marca `ingest_failed` sozinha ([O server ingere](#o-server-ingere)); o reaper
  cobre a que nunca chegou a rodar.
- **Retentar é explícito.** O dono retranscreve (`POST /recordings/{id}/retranscribe`); o admin
  retenta a gravação de qualquer usuário por `POST /admin/jobs/{job_id}/retry`
  ([server-admin.md](../code/server-admin.md)). Os dois criam a revisão seguinte com a
  configuração atual. Não há retentativa automática do `transcribe`: repetiria um OOM ou um áudio
  ruim em laço; só os jobs de retorno retentam a falha passageira. A exceção é o `transcribe` cujo
  enfileiramento se perdeu: ele nunca rodou, então volta à fila uma vez (tabela acima).
- **Prova.** `server/tests/test_stalled.py`, um teste por linha da tabela; a ingestão que falha em
  `server/tests/test_pipeline.py`.

## Sem GPU: dev e produção

`ECLUME_ENGINE=cpu` (faster-whisper `small` int8, sem alinhamento e **sem diarização**: o raw sai
com um locutor). Vale no dev ([desenvolver-sem-gpu.md](../../how-to/desenvolver-sem-gpu.md)), no
E2E e também **em produção** num host sem GPU NVIDIA: `deploy/deploy.sh --sem-gpu` acrescenta
`deploy/docker-compose.cpu.yml`, que define `ECLUME_ENGINE=cpu` e `ECLUME_DEVICE=cpu` no
`worker-gpu` e zera a reserva de GPU dele (`deploy: !reset {}`, Compose 2.24+), com a mesma
imagem. A fila, o contrato do job e o raw são os mesmos; o heartbeat sai sem os campos da NVML
([auto-hospedar.md](../../how-to/auto-hospedar.md#sem-gpu)). Os testes do server usam um worker
fake que publica um `transcript.raw.json` de fixture de `contracts/fixtures/`.

## Como o server cumpre a sua parte

- **Opções.** `options` sai da configuração da plataforma (`platform_settings`) e da conta. O
  idioma se resolve **uma vez, ao enfileirar** (upload, retranscrever e o retentar do admin passam
  por `insert_job`), nesta ordem: o do arquivo (`recordings.language`, dito no upload, no `PATCH` ou
  no retranscrever), o preferido da conta (`users.transcription_language`, `GET`/`PATCH
  /me/transcription`), o padrão do servidor (`asr.default_language`) e `pt`; vai sem região
  (`pt-BR` → `pt`). Mudar a preferência da conta não mexe nos jobs já enfileirados. `auto` em
  qualquer nível é um pedido de detecção (`options.language = null`), nunca um resultado: a
  ingestão grava em `recordings.language` e na transcrição o idioma detectado (o do raw) e, sem
  ele, o padrão resolvido; `auto` só aparece na gravação enquanto a detecção não roda. `diarize` é
  a diarização ligada; `embeddings` só é `true` com a identificação por voz ligada na plataforma (LGPD).
- **Revisão.** A `revision` do job é a da transcrição que ele vai produzir: 1 no primeiro;
  numa retranscrição, uma acima da maior entre a transcrição e o último job. Todo caminho que cria
  uma revisão ou fecha o job (retranscrever, retentar do admin, `ingest`, `fail`) trava a linha de
  `recordings` com `SELECT … FOR UPDATE` num comando próprio e só então lê o job em outro: em READ
  COMMITTED, quem esperou o lock vê o job novo, e o segundo de dois pedidos simultâneos recebe 409
  em problem+json.
- **Estado do job.** Com o hash de progresso presente, o job aparece `running` e a gravação
  `processing`; `stage` vira `Job.stage` do contrato v1 (`download`/`asr` → `asr`, `align` →
  `alignment`, `diarize` → `diarization`, `embed` → `embeddings`, `upload` → `finalizing`) e
  `progress = pct / 100`, só com o hash da revisão do job em aberto (ou sem `revision`). O
  `ingest_transcript` e o `transcription_failed` apagam o hash só quando fecham o job.
- **Ingestão tolerante.** O raw é lido com padrões para o que faltar e ignorando o que não se
  conhece; um id de locutor fora de `S<n>` é renumerado na ordem em que aparece, e o mesmo mapa
  vale para os embeddings. Com o job já `succeeded`, `ingest_transcript` não faz nada.
- **Espera na fila** (`queue_status.py`, holetz/eclume#117). `Job.queue` é calculado na leitura
  (`render`), só para as gravações com job `queued` sem progresso, uma vez por resposta: um
  `ZRANGE` de `eclume:gpu`, a presença do heartbeat, o último visto e, para os retidos, uma
  consulta da conta. Despachado (`dispatched_at`): `processor_queue` com `ahead` = posição do
  `_job_id` no ZSET, que inclui o job rodando. Retido: `quota_window` com `resumes_at` quando a
  conta, sem job despachado, está fora dos minutos de 24 h (o instante em que o despacho mais
  antigo que a põe abaixo da cota sai da janela); senão `account_turn` com `account_ahead` = os
  jobs abertos da conta antes dele (o despachado primeiro, depois os retidos por `queued_at`).
  `processor.online` = heartbeat presente.
- **Estimativa.** Ritmo = mediana de `(finished_at − started_at) / duration_ms` das últimas 20
  transcrições bem-sucedidas em 7 dias, de toda a plataforma (só números, papel de conexão), e a
  mediana do processamento; guardado 5 min em `eclume:queue:pace`; com menos de 5 amostras, sem
  estimativa. Início estimado = agora + a soma, para cada job à frente, de `duration_ms × ritmo`
  (sem duração, a mediana do processamento), descontado do que roda o tempo decorrido desde o
  `started_at` do hash de progresso (nunca negativo). Processador fora do ar: `null`.
- **Prova.** `server/tests/test_pipeline.py` roda o ciclo com o worker GPU fake de
  `server/tests/eclume_server_testing/fakes.py` e o worker CPU real.

## Como o worker cumpre a sua parte

- **Execução.** `max_jobs=1` e `max_tries=1`. Uma falha não relança exceção: o worker enfileira
  `transcription_failed` e encerra o job, e o retry é decisão do server. A `revision` é lida do
  `_job_id`; sem ela, vale 1. Ela vai ao hash de progresso, às chaves `r{revision}/` e ao `_job_id`
  dos dois retornos. O job em curso fica marcado do início ao fim (inclusive o enfileiramento do
  retorno), e o heartbeat publica `busy` e `job_id` por ele.
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
  `embedding_model` e `dimension` são `null`. Vetor com qualquer componente não finito (NaN ou
  infinito — o pyannote o produz para fala curta demais) fica de fora: o locutor segue no raw, só
  sem embedding. Não é erro.
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
| `audio_decode_failed` | o contêiner está fora da lista permitida, ou o ffmpeg não decodifica o áudio nem para só converter o formato (dentro do tempo limite) |
| `out_of_memory` | falta VRAM mesmo com lote 1 e o modelo `medium` |
| `asr_failed` | erro no ASR que não é falta de memória |
| `alignment_failed` | erro no alinhamento por palavra |
| `diarization_failed` | erro na diarização com o modelo acessível |
| `upload_failed` | falha ao gravar os artefatos no bucket |
| `internal_error` | engine desconhecida ou mal configurada, ou erro inesperado |

A prova do lado do worker é `worker-gpu/tests/test_jobs.py` (fakes) e
`worker-gpu/tests/test_gpu_e2e.py`, que roda no host GPU contra `deploy/docker-compose.gpu-test.yml`.
