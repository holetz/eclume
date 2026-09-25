---
type: project
title: Worker GPU na GTX 1660 SUPER
description: Como o worker GPU do eclume (WhisperX large-v3-turbo, alinhamento wav2vec2 pt, diarização pyannote community-1) roda no host 192.168.15.199 — compute type, benchmark medido, imagem, cache de modelos, token do Hugging Face e operação.
resource: worker-gpu/**, engines/src/eclume_engines/**, deploy/docker-compose.gpu-test.yml
tags: [worker-gpu, whisperx, gpu, benchmark, runbook]
timestamp: 2026-09-24
audience: both
authority: current
source: holetz/eclume#8
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
