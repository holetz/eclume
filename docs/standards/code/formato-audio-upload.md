---
type: standard
title: Formato do áudio enviado pelo navegador
description: Antes do upload, o navegador converte áudio e vídeo para Opus mono 16 kHz em Ogg (32 kbps) pela biblioteca isolada web/src/lib/media-convert — WebCodecs com Mediabunny, ffmpeg.wasm de fallback — e este é o formato, o porquê e a API que o app consome.
resource: web/src/lib/media-convert/**, web/vitest.browser.config.ts, web/scripts/media-fixtures.sh
tags: [code, web, audio, opus, webcodecs, upload]
timestamp: 2026-09-24
audience: both
authority: current
source: holetz/eclume#7
maintainer: holetz
---

# Formato do áudio enviado pelo navegador

Arquivos de reunião chegam com vários GB, mas só o áudio interessa ao ASR. Por isso o navegador
**converte antes de subir**, e o servidor recebe sempre o mesmo formato.

## O formato-alvo: Opus mono 16 kHz em Ogg, 32 kbps

| Propriedade | Valor | Por quê |
|---|---|---|
| Codec | Opus | Fala transparente a 24–32 kbps; lido por ffmpeg, WhisperX e navegadores |
| Canais | 1 (mono) | O Whisper/WhisperX processa mono; o downmix é feito na conversão |
| Taxa | 16 kHz | É a taxa de entrada do Whisper; mais que isso é banda desperdiçada |
| Bitrate | 32 kbps (aceita 16–64 kbps) | ~14,4 MB por hora de áudio |
| Contêiner | Ogg (`audio/ogg; codecs=opus`, `.ogg`) | O Ogg do Mediabunny é append-only: a saída sai em ordem, sem reescrever cabeçalho |

**Opus decodifica sempre a 48 kHz.** Os 16 kHz ficam no campo *input sample rate* do cabeçalho
`OpusHead`. Por isso a verificação lê o `OpusHead` (byte 9 = canais; bytes 12–15, little-endian =
taxa de entrada), e **não** o `sample_rate` do ffprobe, que reporta 48000 para qualquer Opus.

## Onde a conversão vive

`web/src/lib/media-convert/` é uma biblioteca autocontida, testável sem o app:

- **nada dentro dela importa de fora da pasta** — o `eslint.config.js` recusa import que comece
  com `../` ou `/` em `src/lib/media-convert/**`;
- **o app importa só de `src/lib/media-convert`** (o `index.ts`), nunca de um módulo interno.

Os dois motores são carregados **sob demanda** (`import()` dinâmico): importar a biblioteca custa
~5 KB; o Mediabunny (~140 KB gzip) chega na primeira conversão, e o ffmpeg.wasm (~32 MB de wasm)
só quando o fallback é usado.

## Os motores

- **WebCodecs com Mediabunny (via principal).** A entrada é lida em fatias
  (`CustomSource` sobre `blob.slice()`), então um vídeo de vários GB nunca entra inteiro na
  memória; o vídeo é descartado, o áudio é decodificado, reamostrado para 16 kHz mono e
  codificado em Opus. A saída (~14 MB/h) fica em memória.
- **ffmpeg.wasm (fallback).** Core single-thread (`@ffmpeg/core`) servido pela própria origem
  (import `?url` do Vite), sem CDN e sem COOP/COEP. A entrada é montada com `WORKERFS`, que lê o
  arquivo sob demanda. O `vite.config.ts` exclui `@ffmpeg/ffmpeg` do pré-bundle, que quebraria a
  URL do worker.
- **Quando cai para o fallback:** em `engine: 'auto'`, quando o WebCodecs falha com `unsupported`
  (contêiner que o Mediabunny não lê, como AVI; codec sem decoder no navegador) ou `failed`, ou
  quando o navegador não tem `AudioEncoder`/`AudioDecoder`. `no-audio` e `aborted` nunca caem.
- **Bitrate no Mediabunny:** use `new Quality({ bitrate })`. `new Quality(32000)` com um número é
  um nível *qualitativo* (0–1), não um bitrate — o encoder recusa a config e tudo cai no fallback.

## A API pública

```ts
convertAudio(file: Blob, options?: {
  signal?: AbortSignal
  onProgress?: (p: { ratio: number; bytesRead: number; bytesTotal: number }) => void
  bitrate?: number                           // 16_000..64_000; padrão 32_000
  engine?: 'auto' | 'webcodecs' | 'ffmpeg'   // padrão 'auto'
}): Promise<{ blob: Blob; sha256: string; durationSec: number; engine: 'webcodecs' | 'ffmpeg' }>

probeMedia(file: Blob, options?: { bitrate?: number }): Promise<{
  durationSec: number | null; hasAudio: boolean | null; estimatedBytes: number | null
  engine: 'webcodecs' | 'ffmpeg'             // o motor que 'auto' vai usar
}>

estimateOutputSize(durationSec: number, bitrate?: number): number
checkEnvironment(): { secureContext: boolean; webCodecs: boolean; subtleCrypto: boolean }
class MediaConvertError extends Error {
  code: 'insecure-context' | 'no-audio' | 'unsupported' | 'aborted' | 'failed'
}
OUTPUT_FORMAT, DEFAULT_BITRATE, MIN_BITRATE, MAX_BITRATE, sha256Hex
```

- **Contexto seguro é pré-requisito.** Sem HTTPS (`isSecureContext` falso) `convertAudio` rejeita
  com `insecure-context` antes de ler o arquivo, com mensagem em pt-BR pedindo `https://`.
- **Erros:** toda falha de conversão sai como `MediaConvertError` com `code`, mensagem em pt-BR e
  a causa original em `cause`. Argumento inválido (bitrate fora da faixa, duração negativa) é
  erro de programação e lança `RangeError`.
- **Hash:** `sha256` é o SHA-256 do `blob` em hex minúsculo — o valor que o upload com dedup
  envia.
- **Progresso:** `ratio` vai de 0 a 1 e nunca recua dentro de um motor; ao cair para o fallback,
  recomeça do zero uma vez. `bytesRead` são os bytes realmente lidos do arquivo e podem terminar
  abaixo de `bytesTotal`, porque o demuxer pula o vídeo; no ffmpeg.wasm, é estimado pela razão.
- **Duração:** `durationSec` é relida do próprio arquivo convertido.

## Como é verificado

- **Unitários** (`npm --prefix web test`, ambiente node): ambiente, estimativa, hash, progresso,
  erros e a escolha de motor com os motores substituídos por dublês.
- **Navegador** (`npm run fixtures && npm run test:browser`, **só no host de build** por
  `remote-run`): vitest browser mode com `@vitest/browser-playwright` no canal `chrome` — o
  Google Chrome tem os decoders proprietários (AAC), que o Chromium do Playwright não tem.
  `scripts/media-fixtures.sh` gera, com ffmpeg, 10 s de áudio estéreo 48 kHz em MP4, MOV, M4A,
  WebM, MKV, MP3, WAV e OGG (todos pelo WebCodecs), AVI (pelo fallback), um MP4 sem áudio e
  arquivos de 120 s para o cancelamento. A saída tem de ter `OpusHead` com 1 canal e 16000 Hz,
  duração de 10 s ± 0,5 s, tamanho entre 50% e 150% de `estimateOutputSize` e o `sha256` do
  próprio blob.
- Provado em Chrome 154 headless no host (2026-09-24): o `AudioEncoder` aceita Opus a 16 kHz mono,
  e as oito fixtures convertem pelo WebCodecs.
- Os testes de navegador ainda não rodam na CI do GitHub.
- Para validar à mão: `npm --prefix web run dev` e abrir `/media-convert.html` (só no dev, fora do
  build de produção).
