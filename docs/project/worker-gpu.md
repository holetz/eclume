---
type: project
title: Worker GPU na GTX 1660 SUPER
description: Como o worker GPU do eclume (WhisperX large-v3-turbo, alinhamento wav2vec2 pt, diarização pyannote community-1) roda no host 192.168.15.199 — compute type, benchmark medido, imagem, pré-processamento com o modelo do RNNoise, cache de modelos, token do Hugging Face e operação.
resource: worker-gpu/**, engines/src/eclume_engines/**, deploy/docker-compose.gpu-test.yml
tags: [worker-gpu, whisperx, gpu, benchmark, runbook]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#8, holetz/eclume#12, holetz/eclume#26, holetz/eclume#33
maintainer: holetz
---

# Worker GPU na GTX 1660 SUPER

O worker GPU (`worker-gpu/`, pacote `eclume_worker`) consome a fila `eclume:gpu` e roda a engine
`whisperx-local` (`engines/`). O contrato de jobs com o server está em
[jobs-transcricao.md](/docs/standards/api/jobs-transcricao.md). As medidas abaixo são do host
`192.168.15.199`: GTX 1660 SUPER, 6 GB, Turing TU116 sem tensor cores, driver 595.91.07, 4 CPUs.

## Compute type no TU116

A decisão do épico é `large-v3-turbo` com `compute_type=int8_float16`, e ela se confirmou no
TU116. O `fp16` puro fica proibido pelo histórico de NaN na série GTX 16xx; a engine o recusa e
usa `int8_float16`, com o aviso `compute_type_float16_rejected`.

- O CTranslate2 4.8.2 da imagem lista, para a GPU, os tipos `int8_float16`, `float16`,
  `float32`, `int8_float32` e `int8`.
- Com `int8_float16`, 1 h de fala em português saiu legível e completa: 670 segmentos, 7.904
  palavras e todas as palavras com tempo do alinhamento. Não houve NaN nem segmento vazio.
- Como o `int8_float16` não falhou, `int8` e `float32` não foram medidos. Eles ficam como recuo
  automático, nessa ordem, se o CTranslate2 recusar o tipo pedido.

## Benchmark

**Áudio:** 1 h de fala real em português — contos de Artur Azevedo lidos por voluntários do
LibriVox (domínio público), convertidos para o formato do upload (Opus mono 16 kHz, 32 kbps,
14,1 MB). O script `worker-gpu/scripts/make-test-audio.sh bench` o reproduz.

**Como medir:** `python -m eclume_worker.bench` dentro da imagem, com o worker do compose parado
e os modelos já no cache. A GPU tinha 349 MiB em uso antes (Xorg e Jellyfin ocioso), com 5.396 MiB
livres. A VRAM de pico é o uso do dispositivo inteiro menos essa linha de base, amostrado pela
NVML a cada 0,2 s. O tempo é o do pipeline inteiro, com o carregamento dos modelos.

```bash
docker --context gpu-host run --rm --gpus all -v /srv/eclume/models:/models \
  -v /srv/eclume/bench:/bench -v /srv/eclume/secrets:/run/secrets:ro \
  eclume-worker-gpu:dev python -m eclume_worker.bench /bench/bench-1h.ogg --no-diarize
```

### Sem diarização (ASR `large-v3-turbo` `int8_float16` + alinhamento wav2vec2 pt)

| Lote do ASR | Processamento de 1 h | Fator de tempo real | Min por hora de áudio | VRAM de pico |
|---|---|---|---|---|
| 4 | 357 s | 0,099 | 5,95 | 2.999 MiB |
| 8 | 381 s | 0,106 | 6,35 | 2.997 MiB |
| 16 | 370 s | 0,103 | 6,16 | 3.873 MiB |

- **O lote não muda o tempo:** a 1660 SUPER já satura com 4. O 16 só sobe o pico em ~0,9 GB.
  Por isso o lote inicial é 4 com pelo menos 3,5 GB livres e 2 abaixo disso
  (`initial_batch_size`), e `ECLUME_BATCH_SIZE` fixa outro valor se preciso.
- **O pico de ~3 GB com lote 4 e 8 é do alinhamento.** O wav2vec2 large roda em fp32, e o
  modelo do ASR já foi descarregado antes dele.
- **Com memória disputada,** um processo alheio segurando 2,9 GB, o lote caiu sozinho para 4 e
  1 h levou 355 s, com pico de 2,1 GB.
- **Um job curto paga o carregamento dos modelos.** Os 30 s do diálogo de teste levam ~26 s com
  diarização, quase tudo carregando ASR, alinhador e pyannote, porque há um modelo residente
  por vez. Numa hora de áudio, isso é ~5% do tempo.

### Com diarização e embeddings (pyannote `community-1`, `return_embeddings=True`)

| Lote do ASR | Processamento de 1 h | Fator de tempo real | Min por hora de áudio | VRAM de pico |
|---|---|---|---|---|
| 4 | 517 s | 0,144 | 8,61 | 3.003 MiB |
| 16 | 542 s | 0,151 | 9,03 | 3.873 MiB |

- **A diarização custa ~3 min por hora de áudio.** Com lote 4, ASR e alinhamento levaram
  ~330 s e a diarização com embeddings ~180 s. Ela não sobe o pico, porque roda depois de o
  alinhador sair da GPU.
- **Os locutores batem com os leitores.** A 1 h junta cinco contos, e o pyannote achou 3
  locutores. As trocas caíram nas fronteiras dos contos (24:10, 36:50, 46:39, 56:09), com dois
  trechos de menos de 1 s atribuídos ao locutor vizinho.
- **Os embeddings são do `pyannote/wespeaker-voxceleb-resnet34-LM`,** com 256 dimensões, um
  vetor por locutor em `speaker_embeddings.json`.
- **No diálogo sintético de 30 s** (duas vozes do Piper, `min_speakers=max_speakers=2`), o teste
  de integração separou os 2 locutores e alternou as falas certo, exceto a primeira frase ("Bom
  dia, pessoal."), atribuída ao outro locutor.

### ASR residente entre jobs (holetz/eclume#26)

Medido em 2026-09-25 com a imagem de produção, o worker do stack ocioso (sem modelo carregado) e
5.396 MiB livres: a fixture `two-voices.ogg` (30,4 s), três jobs seguidos na mesma engine
(`python -m eclume_worker.bench a.ogg --repeat 3`, com e sem `--single-slot`). Sem token do
Hugging Face no host, a diarização não roda; o pyannote seria recarregado a cada job nos dois modos,
então a diferença abaixo é a carga do ASR.

| Modo | Job 1 (frio) | Job 2 | Job 3 |
|---|---|---|---|
| um modelo por vez (`--single-slot`, o de antes) | 23,2 s | 10,4 s | 10,5 s |
| ASR residente (padrão) | 20,6 s | 6,1 s | 5,8 s |

Do segundo job em diante, o job curto cai ~43% (≈4,5 s a menos por job): o alinhador ainda é
recarregado, o ASR não. O pico acima da linha de base com o ASR residente foi 1.746 MiB, longe do
limiar de 2.500 MiB livres que faria o ASR sair.

### Qualidade do texto (WER e CER)

`--reference texto.txt` (UTF-8) acrescenta ao JSON o bloco `quality`, com a taxa, o tamanho da
referência e as substituições, remoções e inserções de `wer` (palavras) e `cer` (caracteres). O
texto reconhecido é a junção dos segmentos. A conta é própria, em `eclume_worker.wer`, sem
dependência. Não está ligada ao gate nem a `deploy/`.

```bash
python -m eclume_worker.bench /bench/bench-1h.ogg --no-diarize --reference /bench/bench-1h.txt
```

**Normalização pt-BR**, igual para referência e hipótese: Unicode NFC, minúsculas, pontuação
(inclusive aspas e travessões tipográficos) vira espaço, o hífen e o apóstrofo entre letras ficam
dentro da palavra e os espaços repetidos colapsam. Os acentos são preservados, porque "é" e "e"
são palavras diferentes; números e símbolos não são expandidos ("10" e "dez" contam como erro).
No CER, o espaço entre palavras é um caractere. Referência vazia com hipótese não vazia dá taxa
nula (`null`), sem divisão por zero.

**Memória e tempo do CER.** A distância de edição usa o algoritmo de Hirschberg: memória linear e
tempo quadrático. A matriz completa anterior gastava ~37 bytes por célula e não cabia no host de
15 GB com a referência de 1 h. Medido com `/usr/bin/time -v` em `char_counts`, texto aleatório de
11 símbolos com 15% de troca (pior caso, sem prefixo comum), nesta estação:

| Caracteres | Antes: pico / tempo | Depois: pico / tempo |
| --- | --- | --- |
| 6000 | 1,39 GB / 7,4 s | 46,9 MB / 13,3 s |
| 50000 | não executado (estimado em ~93 GB) | 46,5 MB / 16 min 07 s (967 s) |

O pico "depois" é praticamente o do interpretador. O tempo dobra, e 50 mil caracteres levam uns 16
minutos, uma vez por medição e depois da hora de ASR. Num empate o alinhamento ótimo não é único: a
divisão entre substituições, remoções e inserções pode diferir da versão anterior (no caso de 6000,
798/13/20 antes e 778/23/30 depois), mas o total de erros e a taxa são idênticos (831).

O texto de referência do LibriVox não está no repositório; quem mede o entrega por caminho. Leitores
omitem ou acrescentam trechos, o que infla o WER: o número serve para comparar configurações
(`compute_type`, modelo reserva, versão do WhisperX) no mesmo par áudio/texto, não como valor
absoluto. Ainda não há WER base medido no host.

## Imagem

`worker-gpu/Dockerfile` é construído no host, a partir da raiz do repositório:

```bash
docker --context gpu-host build -t eclume-worker-gpu:dev -f worker-gpu/Dockerfile .
```

- **Sem base `nvidia/cuda`.** A base é `python:3.12-slim-bookworm` com `ffmpeg`, como no
  whisperx-asr-service: as wheels de torch 2.8 (cu128) e do CTranslate2 trazem o runtime
  CUDA/cuDNN, e o NVIDIA Container Toolkit injeta o driver. O Turing (sm_75) está entre as
  arquiteturas das wheels cu128.
- **As dependências saem do `uv.lock`,** com `uv sync --package eclume-worker --extra gpu`. A
  imagem roda a mesma versão que a CI resolveu.
- **Estágio único e sem triton:** ~8 GB. Num multi-stage, o `.venv` de ~7 GB existiria duas
  vezes no disco do host (cache do builder e camada final). O triton só serve ao
  `torch.compile`, que o worker não usa, e sai na mesma camada em que é instalado.
- **O contexto do build é filtrado** por `worker-gpu/Dockerfile.dockerignore`, que o BuildKit lê
  por estar ao lado do Dockerfile. Só os manifestos do workspace e o código de `engines/` e
  `worker-gpu/` entram.
- **Sem modelos na imagem.** Ela roda como uid 1000, o dono de `/srv/eclume`, com `HOME=/tmp`.

## Pré-processamento

Antes do ASR, o job trata o áudio com o `ffmpeg` da imagem (Debian bookworm, 5.1, com `arnndn`,
`afftdn`, `loudnorm`, `silencedetect`, `atrim` e `pan`), pela configuração que o admin define em
Pré-processamento e que chega em `options.preprocess`. A ordem e as regras estão no
[contrato de jobs](../standards/api/jobs-transcricao.md#pré-processamento).

- **Modelo do RNNoise:** o `cb.rnnn` (conjoined-burgers, de GregorR/rnnoise-models, treinado em
  fala geral com ruído de ambiente) entra na imagem por `ADD --checksum`, em
  `/opt/eclume/rnnoise/cb.rnnn`, com `ECLUME_RNNOISE_MODEL` apontando para ele. Sem o arquivo (dev
  fora da imagem), a redução de ruído usa `afftdn` e avisa `rnnoise_model_missing`.
- **Conferir a imagem:**

  ```bash
  docker --context gpu-host run --rm --entrypoint sh eclume-worker-gpu:dev \
    -c 'test -s "$ECLUME_RNNOISE_MODEL" && ffmpeg -hide_banner -filters | grep -E "arnndn|loudnorm|silencedetect"'
  ```

- O áudio tratado fica só em `ECLUME_WORK_DIR` e sai com o job; o bucket guarda o original.
- Os testes (`worker-gpu/tests/test_preprocess.py`) usam áudios sintéticos do `lavfi` e rodam onde
  há `ffmpeg` (o host, `remote-run`); sem ele, pulam.

## Modelos e token

- **Cache de modelos:** `/srv/eclume/models`, montado em `/models` (`HF_HOME=/models/huggingface`,
  `TORCH_HOME=/models/torch`). O primeiro job baixa ~3,9 GB: `large-v3-turbo` (CTranslate2), o
  wav2vec2 pt `jonatasgrosman/wav2vec2-large-xlsr-53-portuguese` e o pyannote `community-1`. O
  `punkt_tab` do NLTK, que o alinhamento usa, vem embutido na imagem.
- **Token do Hugging Face:** `/srv/eclume/secrets/hf_token` (chmod 600, dono holetz), montado
  em `/run/secrets/hf_token`, ou a variável `HF_TOKEN`. Ele é relido a cada job, então criar ou
  trocar o token não exige reiniciar o worker. A conta do token precisa ter aceitado os termos
  de `pyannote/speaker-diarization-community-1`; a segmentação e o embedding estão no mesmo
  repositório.
- **Conferir o acesso:**

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" -L -H "Authorization: Bearer $(cat /srv/eclume/secrets/hf_token)" \
    https://huggingface.co/pyannote/speaker-diarization-community-1/resolve/main/config.yaml   # 200
  ```

- **Token da plataforma:** o admin grava o token em Administração → Locutores, e ele chega a
  cada job cifrado nas `options` (`hf_token_encrypted`), com precedência sobre `HF_TOKEN` e o
  arquivo. Para abri-lo, o worker precisa de `ECLUME_ENCRYPTION_KEY` (ou `ECLUME_SECRET_KEY`)
  **igual à do server**; sem ela, o job avisa `hf_token_undecryptable` e usa o token do ambiente.
- **Sem token ou sem acesso,** o worker transcreve e alinha com um locutor só e avisa em
  `engine_info.warnings`.

## Operação

```bash
docker --context gpu-host compose -p eclume-gpu-test -f deploy/docker-compose.gpu-test.yml up -d --build --wait
remote-run . 'ECLUME_GPU_E2E=1 uv run pytest worker-gpu/tests/test_gpu_e2e.py -v -s'
docker --context gpu-host compose -p eclume-gpu-test -f deploy/docker-compose.gpu-test.yml down -v
```

| Variável | Padrão | O que faz |
|---|---|---|
| `ECLUME_REDIS_URL` | `redis://localhost:6379/0` | Redis das filas e do progresso |
| `ECLUME_S3_BUCKET`, `ECLUME_S3_ENDPOINT_URL`, `ECLUME_S3_ACCESS_KEY`, `ECLUME_S3_SECRET_KEY`, `ECLUME_S3_REGION` | `eclume`, —, —, —, `us-east-1` | bucket do áudio e dos artefatos (MinIO) |
| `ECLUME_ENGINE` | vazio | força a engine do processo (`cpu` em dev e no E2E); vazio, vale `options.engine`. Forçada, ignora modelo, compute type e lote do admin |
| `ECLUME_DEVICE` | `cuda` | dispositivo do torch e do CTranslate2 |
| `ECLUME_BATCH_SIZE` | vazio | lote inicial fixo do ASR; vazio, vem da VRAM livre |
| `ECLUME_MODEL_IDLE_SECONDS` | `300` | descarrega os modelos após esse tempo sem job |
| `ECLUME_RECYCLE_ON_IDLE` | `1` | após a descarga ociosa, encerra o processo se o torch foi importado (o contêiner sobe de novo sem ele); `0` mantém o processo |
| `ECLUME_KEEP_ASR_RESIDENT` | `1` | mantém o ASR carregado entre as etapas e entre jobs; `0` volta a um modelo por vez |
| `ECLUME_RESIDENT_MIN_FREE_MB` | `2500` | VRAM livre mínima, com o ASR carregado, para ele ficar ao carregar o alinhador ou o pyannote |
| `ECLUME_JOB_TIMEOUT_SECONDS` | `21600` | limite de um job (6 h) |
| `ECLUME_WORK_DIR` | `/tmp/eclume-work` | onde o áudio é baixado; limpo ao fim do job |
| `HF_TOKEN`, `ECLUME_HF_TOKEN_FILE` | —, `/run/secrets/hf_token` | token do Hugging Face (o da plataforma, vindo no job, vence) |
| `ECLUME_ENCRYPTION_KEY`, `ECLUME_SECRET_KEY` | — | as mesmas do server: abrem o token do HF que chega cifrado no job |
| `ECLUME_REMOTE_BASE_URL`, `ECLUME_REMOTE_API_KEY`, `ECLUME_REMOTE_MODEL` | — | engine `openai-compatible` (speaches) |

- **Heartbeat.** A cada 15 s o worker grava `eclume:gpu:health` (TTL 45 s) com a GPU pela NVML,
  o modelo residente e se há job rodando; é o que Administração → Saúde mostra. Para conferir no
  host: `redis-cli HGETALL eclume:gpu:health` no Redis do stack. Medido na GTX 1660 SUPER em
  2026-09-25: nome, 6.144 MiB de total e a VRAM do stack de produção (3.659 MiB) lidos certo; o
  hash some em até 45 s depois de um `kill` e na hora num `docker stop`.
- **VRAM compartilhada com o Jellyfin.** Há no máximo dois modelos na GPU: o ASR, residente entre
  jobs, e o da etapa em curso (alinhador ou pyannote), que sai no fim do job, também quando uma
  etapa falha. Antes de carregar o
  da etapa com menos de `ECLUME_RESIDENT_MIN_FREE_MB` livres — o Jellyfin transcodificando, por
  exemplo —, o ASR sai; um OOM numa etapa com ele residente o descarrega e repete a etapa. Depois
  de `ECLUME_MODEL_IDLE_SECONDS` sem job, o worker descarrega tudo e fica só com o contexto CUDA
  (~120 MiB). `python -m eclume_worker.bench <áudio> --repeat 3` mede jobs seguidos na mesma
  engine (`runs_s`), e `--single-slot` o comportamento de um modelo por vez.
- **Reciclo do processo na ociosidade.** Descarregar os modelos devolve a VRAM, mas o processo
  seguia com ~4,4 GB de memória anônima (torch, CTranslate2, pyannote e as arenas do glibc) e com
  ~150 MiB de VRAM do contexto CUDA (medido em 2026-10-06). Por isso, logo após a descarga
  ociosa, se `torch` está em `sys.modules` e não há job em curso, o worker loga "reciclando o
  processo para devolver a memória" com a RSS do momento e envia `SIGTERM` a si mesmo: o arq para
  de pegar jobs, roda o `shutdown` (retira o heartbeat) e sai; o `restart: unless-stopped` sobe um
  processo novo que não importa torch até o próximo job (o `healthcheck.start_period` cobre a
  volta). Um processo leve, que nunca importou torch, não reinicia. O custo é recarregar os
  modelos no job seguinte à ociosidade, que já era o caso depois da descarga. Complementam
  `MALLOC_ARENA_MAX=2` na imagem e `poll_delay` de 2 s no arq. O `vigia.sh` não alerta esse
  reinício: o contêiner só conta como ruim em duas rodadas seguidas, e o heartbeat ausente
  também.
- **Falta de memória.** Um OOM no ASR corta o lote pela metade até 1. Se ainda faltar, o modelo
  cai para `medium` (aviso `fallback_medium`). A cada recuo, o modelo anterior sai da VRAM antes
  da nova tentativa. Esgotado isso, o job falha com `out_of_memory`.
- **Disco.** O host tem pouco espaço livre. Confira `df -h /` antes de um build, e, depois de
  testar, derrube o compose com `down -v` e apague as imagens `eclume-worker-gpu` antigas.
