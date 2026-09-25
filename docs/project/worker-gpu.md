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
