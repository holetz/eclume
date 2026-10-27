---
type: standard
title: Format of the audio the browser sends
description: Before the upload, the browser converts audio and video to Opus mono 16 kHz in Ogg (32 kbps) through the isolated library web/src/lib/media-convert — WebCodecs with Mediabunny, ffmpeg.wasm as the fallback — and this is the format, the reason and the API the app consumes.
resource: web/src/lib/media-convert/**, web/vitest.browser.config.ts, web/scripts/media-fixtures.sh
tags: [code, web, audio, opus, webcodecs, upload]
timestamp: 2026-09-27
audience: both
authority: current
source: holetz/eclume#7, holetz/eclume#37
maintainer: holetz
---

# Format of the audio the browser sends

Meeting files arrive at several GB, but only the audio matters to ASR. That is why the browser
**converts before uploading**, and the server always receives the same format.

## The target format: Opus mono 16 kHz in Ogg, 32 kbps

| Property | Value | Why |
|---|---|---|
| Codec | Opus | Transparent speech at 24–32 kbps; read by ffmpeg, WhisperX and browsers |
| Channels | 1 (mono) | Whisper/WhisperX processes mono; the downmix is done in the conversion |
| Rate | 16 kHz | It is Whisper's input rate; anything more is wasted bandwidth |
| Bitrate | 32 kbps (accepts 16–64 kbps) | ~14.4 MB per hour of audio |
| Container | Ogg (`audio/ogg; codecs=opus`, `.ogg`) | Mediabunny's Ogg is append-only: the output comes out in order, without rewriting a header |

**Opus always decodes at 48 kHz.** The 16 kHz sit in the *input sample rate* field of the
`OpusHead` header. That is why the check reads the `OpusHead` (byte 9 = channels; bytes 12–15, little-endian =
input rate), and **not** ffprobe's `sample_rate`, which reports 48000 for any Opus.

## Where the conversion lives

`web/src/lib/media-convert/` is a self-contained library, testable without the app:

- **nothing inside it imports from outside the folder** — `eslint.config.js` refuses an import that starts
  with `../` or `/` in `src/lib/media-convert/**`;
- **the app imports only from `src/lib/media-convert`** (the `index.ts`), never from an internal module.

The two engines are loaded **on demand** (dynamic `import()`): importing the library costs
~5 KB; Mediabunny (~140 KB gzip) arrives on the first conversion, and ffmpeg.wasm (~32 MB of wasm)
only when the fallback is used.

## The engines

- **WebCodecs with Mediabunny (main path).** The input is read in slices
  (`CustomSource` over `blob.slice()`), so a video of several GB never enters memory whole;
  the video is discarded, the audio is decoded, resampled to 16 kHz mono and
  encoded in Opus. The output (~14 MB/h) stays in memory.
- **ffmpeg.wasm (fallback).** A single-thread core (`@ffmpeg/core`) served by the origin itself
  (Vite's `?url` import), with no CDN and no COOP/COEP. The input is mounted with `WORKERFS`, which reads the
  file on demand. `vite.config.ts` excludes `@ffmpeg/ffmpeg` from the pre-bundle, which would break the
  worker URL.
- **When it falls back:** under `engine: 'auto'`, when WebCodecs fails with `unsupported`
  (a container Mediabunny does not read, such as AVI; a codec with no decoder in the browser) or `failed`, or
  when the browser has no `AudioEncoder`/`AudioDecoder`. `no-audio` and `aborted` never fall back.
- **Bitrate in Mediabunny:** use `new Quality({ bitrate })`. `new Quality(32000)` with a number is
  a *qualitative* level (0–1), not a bitrate — the encoder refuses the config and everything falls back.

## The public API

```ts
convertAudio(file: Blob, options?: {
  signal?: AbortSignal
  onProgress?: (p: { ratio: number; bytesRead: number; bytesTotal: number }) => void
  bitrate?: number                           // 16_000..64_000; default 32_000
  engine?: 'auto' | 'webcodecs' | 'ffmpeg'   // default 'auto'
}): Promise<{ blob: Blob; sha256: string; durationSec: number; engine: 'webcodecs' | 'ffmpeg' }>

probeMedia(file: Blob, options?: { bitrate?: number }): Promise<{
  durationSec: number | null; hasAudio: boolean | null; estimatedBytes: number | null
  engine: 'webcodecs' | 'ffmpeg'             // the engine 'auto' will use
}>

estimateOutputSize(durationSec: number, bitrate?: number): number
checkEnvironment(): { secureContext: boolean; webCodecs: boolean; subtleCrypto: boolean }
class MediaConvertError extends Error {
  code: 'insecure-context' | 'no-audio' | 'unsupported' | 'aborted' | 'failed'
}
OUTPUT_FORMAT, DEFAULT_BITRATE, MIN_BITRATE, MAX_BITRATE, sha256Hex
```

- **A secure context is a prerequisite.** Without HTTPS (`isSecureContext` false) `convertAudio` rejects
  with `insecure-context` before reading the file, with a pt-BR message asking for `https://`.
- **Errors:** every conversion failure comes out as a `MediaConvertError` with `code`, a pt-BR message and
  the original cause in `cause`. An invalid argument (bitrate out of range, negative duration) is a
  programming error and throws `RangeError`.
- **Hash:** `sha256` is the SHA-256 of the `blob` in lowercase hex — the value the deduplicated upload
  sends.
- **Progress:** `ratio` goes from 0 to 1 and never goes back within an engine; on falling back,
  it restarts from zero once. `bytesRead` are the bytes actually read from the file and may end
  below `bytesTotal`, because the demuxer skips the video; in ffmpeg.wasm, it is estimated from the ratio.
- **Duration:** `durationSec` is reread from the converted file itself.

## The recording start, read before the conversion

The converted Opus does not carry the original's metadata. That is why the import reads the **recording
start** of the original file at selection, in parallel with `probeMedia` and before converting:

```ts
readRecordedAt(file: Blob, options?: { now?: Date }): Promise<{
  at: Date
  source: 'metadata' | 'file_date'
  precision: 'minute' | 'day'
  detail: string                  // mvhd, DateUTC, the tag read, or lastModified
}>
```

The sources, in order of preference:

1. **MP4, MOV and M4A:** the `creation_time` of `moov/mvhd`, in seconds since 1904-01-01 UTC
   (versions 0 and 1). A box reader of its own walks the top-level boxes through `blob.slice` of
   16 bytes, because the `moov` may be at the end of the file, and reads only the `mvhd`. Mediabunny 1.59
   skips that field in the demux.
2. **Matroska and WebM:** the `DateUTC` (ID `0x4461`, nanoseconds since 2001-01-01 UTC) in the segment's
   `Info`, searched for in the first 256 KB.
3. **The tags through Mediabunny** (`getMetadataTags()`, loaded on demand): QuickTime
   `com.apple.quicktime.creationdate`, ID3 `TDRC`, `©day`, Vorbis `DATE` and WAV `ICRD`. A tag without a
   time zone is local time. A tag with only the day gets `precision: 'day'` and takes the time of the
   modification date when it is the same local day; otherwise, 12:00.
4. **Fallback:** `file.lastModified`, with `source: 'file_date'`.

Sources 1 and 2 are UTC. A zeroed date (1904 or 1970), one before 1990 or one more than a day in the
future is discarded and the reading moves to the next source. `readRecordedAt` never rejects: a read
failure becomes the fallback.

**What the import sends.** The person confirms or corrects the date per file. The upload sends
`recorded_at` (the local value converted to ISO) and `recorded_at_source`: `file_metadata` when the
date came from the metadata and was not edited; `user` when it was edited or when it came from the fallback,
because the person confirmed a date the file did not carry. The `title` is not sent: without it, the server
uses the file name and the automatic fill can replace it.

## How it is verified

- **Unit** (`npm --prefix web test`, node environment): environment, estimate, hash, progress,
  errors and the engine choice with the engines replaced by doubles; the recording start with
  synthetic `mvhd` and `DateUTC` bytes and simulated tags.
- **Browser** (`npm run fixtures && npm run test:browser`, on the build host through `remote-run`
  and in CI): vitest browser mode with `@vitest/browser-playwright` on the `chrome` channel —
  Google Chrome has the proprietary decoders (AAC), which Playwright's Chromium does not.
  `scripts/media-fixtures.sh` generates, with ffmpeg, 10 s of 48 kHz stereo audio in MP4, MOV, M4A,
  WebM, MKV, MP3, WAV and OGG (all through WebCodecs), AVI (through the fallback), an MP4 without audio and
  120 s files for cancellation. The output must have an `OpusHead` with 1 channel and 16000 Hz,
  a duration of 10 s ± 0.5 s, a size between 50% and 150% of `estimateOutputSize` and the `sha256` of the
  blob itself.
- Proven in headless Chrome 154 on the host (2026-09-24): `AudioEncoder` accepts Opus at 16 kHz mono,
  and the eight fixtures convert through WebCodecs.
- The same tests run on Playwright's Firefox and WebKit (holetz/eclume#113): each engine
  converts through the path it has (WebCodecs when it decodes the track and encodes Opus, the
  ffmpeg.wasm fallback when it does not), and what depends only on WebCodecs is skipped with the reason. On WebKit,
  Vorbis decoding (MKV and OGG) through WebCodecs hangs without an error and is skipped (2026-10-01).
- In CI, the `web-browser` job runs `npm run fixtures && npm run test:browser` on the Google Chrome that
  already ships with the `ubuntu-latest` runner, with ffmpeg installed through apt.
- To validate by hand: `npm --prefix web run dev` and open `/media-convert.html` (dev only, outside the
  production build).
