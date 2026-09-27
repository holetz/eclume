---
type: standard
title: Formato do áudio enviado pelo navegador
description: Antes do upload, o navegador converte áudio e vídeo para Opus mono 16 kHz em Ogg (32 kbps) pela biblioteca isolada web/src/lib/media-convert — WebCodecs com Mediabunny, ffmpeg.wasm de fallback — e este é o formato, o porquê e a API que o app consome.
resource: web/src/lib/media-convert/**, web/vitest.browser.config.ts, web/scripts/media-fixtures.sh
tags: [code, web, audio, opus, webcodecs, upload]
timestamp: 2026-09-27
audience: both
authority: current
source: holetz/eclume#7, holetz/eclume#37
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

## O início da gravação, lido antes da conversão

O Opus convertido não carrega os metadados do original. Por isso o import lê o **início da
gravação** do arquivo original na seleção, em paralelo ao `probeMedia` e antes de converter:

```ts
readRecordedAt(file: Blob, options?: { now?: Date }): Promise<{
  at: Date
  source: 'metadata' | 'file_date'
  precision: 'minute' | 'day'
  detail: string                  // mvhd, DateUTC, a tag lida ou lastModified
}>
```

As fontes, na ordem de preferência:

1. **MP4, MOV e M4A:** o `creation_time` do `moov/mvhd`, em segundos desde 1904-01-01 UTC
   (versões 0 e 1). Um leitor de caixas próprio percorre as caixas de topo por `blob.slice` de
   16 bytes, porque o `moov` pode estar no fim do arquivo, e lê só o `mvhd`. O Mediabunny 1.59
   pula esse campo no demux.
2. **Matroska e WebM:** o `DateUTC` (ID `0x4461`, nanossegundos desde 2001-01-01 UTC) no `Info`
   do segmento, procurado nos primeiros 256 KB.
3. **As tags pelo Mediabunny** (`getMetadataTags()`, carregado sob demanda): QuickTime
   `com.apple.quicktime.creationdate`, ID3 `TDRC`, `©day`, Vorbis `DATE` e WAV `ICRD`. Uma tag sem
   fuso é hora local. Uma tag só com o dia fica com `precision: 'day'` e recebe a hora da data de
   modificação quando é o mesmo dia local; senão, 12:00.
4. **Fallback:** `file.lastModified`, com `source: 'file_date'`.

As fontes 1 e 2 são UTC. Uma data zerada (1904 ou 1970), anterior a 1990 ou mais de um dia no
futuro é descartada e a leitura passa à fonte seguinte. `readRecordedAt` nunca rejeita: falha de
leitura vira o fallback.

**O que o import envia.** A pessoa confirma ou corrige a data por arquivo. O upload manda
`recorded_at` (o valor local convertido em ISO) e `recorded_at_source`: `file_metadata` quando a
data veio dos metadados e não foi editada; `user` quando foi editada ou quando veio do fallback,
porque a pessoa confirmou uma data que o arquivo não trazia. O `title` não vai: sem ele, o servidor
usa o nome do arquivo e o preenchimento automático pode trocá-lo.

## Como é verificado

- **Unitários** (`npm --prefix web test`, ambiente node): ambiente, estimativa, hash, progresso,
  erros e a escolha de motor com os motores substituídos por dublês; o início da gravação com
  bytes sintéticos de `mvhd` e `DateUTC` e tags simuladas.
- **Navegador** (`npm run fixtures && npm run test:browser`, no host de build por `remote-run`
  e na CI): vitest browser mode com `@vitest/browser-playwright` no canal `chrome` — o
  Google Chrome tem os decoders proprietários (AAC), que o Chromium do Playwright não tem.
  `scripts/media-fixtures.sh` gera, com ffmpeg, 10 s de áudio estéreo 48 kHz em MP4, MOV, M4A,
  WebM, MKV, MP3, WAV e OGG (todos pelo WebCodecs), AVI (pelo fallback), um MP4 sem áudio e
  arquivos de 120 s para o cancelamento. A saída tem de ter `OpusHead` com 1 canal e 16000 Hz,
  duração de 10 s ± 0,5 s, tamanho entre 50% e 150% de `estimateOutputSize` e o `sha256` do
  próprio blob.
- Provado em Chrome 154 headless no host (2026-09-24): o `AudioEncoder` aceita Opus a 16 kHz mono,
  e as oito fixtures convertem pelo WebCodecs.
- Na CI, o job `web-browser` roda `npm run fixtures && npm run test:browser` no Google Chrome que
  já vem no runner `ubuntu-latest`, com o ffmpeg instalado por apt.
- Para validar à mão: `npm --prefix web run dev` e abrir `/media-convert.html` (só no dev, fora do
  build de produção).
