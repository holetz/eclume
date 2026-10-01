// Testes reais de conversão em Chrome, Firefox e WebKit headless (npm run test:browser, no host de
// build). As fixtures vêm de scripts/media-fixtures.sh: 10 s de áudio estéreo 48 kHz. Cada motor
// converte pelo caminho que ele tem: o WebCodecs quando decodifica a faixa e codifica Opus, a
// reserva ffmpeg.wasm quando não; o que depende só do WebCodecs é pulado com o motivo.
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny'
import { server } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import {
  checkEnvironment,
  convertAudio,
  type ConvertProgress,
  estimateOutputSize,
  MediaConvertError,
  OUTPUT_FORMAT,
  probeMedia,
} from './index'

const FIXTURE_SECONDS = 10
const VORBIS = new Set(['video.mkv', 'audio.ogg'])

async function fixture(name: string): Promise<File> {
  const response = await fetch(`/src/lib/media-convert/__fixtures__/${name}`)
  if (!response.ok) throw new Error(`fixture ausente: ${name} (rode npm run fixtures)`)
  return new File([await response.blob()], name)
}

/** Lê canais e taxa de entrada do cabeçalho `OpusHead` do primeiro pacote Ogg. */
function readOpusHead(bytes: Uint8Array) {
  const magic = new TextEncoder().encode('OpusHead')
  const at = bytes.findIndex((_, i) => magic.every((b, j) => bytes[i + j] === b))
  if (at < 0) throw new Error('OpusHead ausente')
  const view = new DataView(bytes.buffer, bytes.byteOffset + at)
  return { channels: view.getUint8(9), inputSampleRate: view.getUint32(12, true) }
}

async function expectSpeechOgg(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('OggS')
  expect(blob.type).toBe(OUTPUT_FORMAT.mimeType)
  expect(readOpusHead(bytes)).toEqual({ channels: 1, inputSampleRate: 16_000 })

  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) })
  const track = await input.getPrimaryAudioTrack()
  expect(await track?.getCodec()).toBe('opus')
  expect(track?.numberOfChannels).toBe(1)
  const duration = await input.computeDuration()
  input.dispose()
  expect(Math.abs(duration - FIXTURE_SECONDS)).toBeLessThanOrEqual(0.5)
}

/** O motor sabe codificar Opus pelo WebCodecs (o Firefox e o Chrome sabem; o WebKit, nem sempre). */
async function webCodecsOpus(): Promise<boolean> {
  if (!checkEnvironment().webCodecs) return false
  const config = { codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 }
  return (await AudioEncoder.isConfigSupported(config).catch(() => ({ supported: false }))).supported === true
}

/** O caminho que este motor usa para o arquivo: o WebCodecs se decodifica e codifica, senão a reserva. */
async function expectedEngine(file: File): Promise<'webcodecs' | 'ffmpeg'> {
  const probe = await probeMedia(file)
  return probe.engine === 'webcodecs' && (await webCodecsOpus()) ? 'webcodecs' : 'ffmpeg'
}

async function convertFixture(name: string) {
  const file = await fixture(name)
  const events: ConvertProgress[] = []
  const result = await convertAudio(file, { onProgress: (p) => events.push(p) })

  await expectSpeechOgg(result.blob)
  expect(Math.abs(result.durationSec - FIXTURE_SECONDS)).toBeLessThanOrEqual(0.5)

  const estimate = estimateOutputSize(FIXTURE_SECONDS)
  expect(result.blob.size).toBeGreaterThan(estimate * 0.5)
  expect(result.blob.size).toBeLessThan(estimate * 1.5)
  expect(result.blob.size).toBeLessThan(file.size)

  const digest = await crypto.subtle.digest('SHA-256', await result.blob.arrayBuffer())
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  expect(result.sha256).toBe(hex)

  const ratios = events.map((e) => e.ratio)
  expect(ratios.at(-1)).toBe(1)
  expect(ratios.every((r, i) => i === 0 || r >= ratios[i - 1])).toBe(true)
  const last = events.at(-1)!
  expect(last.bytesTotal).toBe(file.size)
  expect(last.bytesRead).toBeGreaterThan(0)
  expect(last.bytesRead).toBeLessThanOrEqual(file.size)
  return result
}

async function rejection(promise: Promise<unknown>): Promise<MediaConvertError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(MediaConvertError)
    return error as MediaConvertError
  }
  throw new Error('esperava uma rejeição')
}

describe('conversão pelo WebCodecs, ou pela reserva onde o motor não decodifica', () => {
  it.for([
    'video.mp4',
    'video.mov',
    'audio.m4a',
    'video.webm',
    'video.mkv',
    'audio.mp3',
    'audio.wav',
    'audio.ogg',
  ])('%s vira Opus mono 16 kHz em Ogg', async (name, { skip }) => {
    // O WebKit diz decodificar Vorbis pelo WebCodecs e trava sem erro (2026-10-01, Playwright no host).
    skip(server.browser === 'webkit' && VORBIS.has(name), 'o WebKit trava ao decodificar Vorbis pelo WebCodecs')
    const engine = await expectedEngine(await fixture(name))
    expect((await convertFixture(name)).engine).toBe(engine)
  })

  it('estima o tamanho antes de converter', async ({ skip }) => {
    const probe = await probeMedia(await fixture('video.mp4'))
    skip(probe.engine !== 'webcodecs', 'o motor não decodifica AAC pelo WebCodecs: sem estimativa antes da reserva')
    expect(probe.engine).toBe('webcodecs')
    expect(probe.hasAudio).toBe(true)
    expect(Math.abs((probe.durationSec ?? 0) - FIXTURE_SECONDS)).toBeLessThanOrEqual(0.5)
    expect(probe.estimatedBytes).toBe(estimateOutputSize(probe.durationSec!))
  })

  it('recusa vídeo sem áudio', async ({ skip }) => {
    skip(!checkEnvironment().webCodecs, 'sem WebCodecs, a reserva só descobre a falta de áudio convertendo')
    const file = await fixture('sem-audio.mp4')
    expect((await rejection(convertAudio(file))).code).toBe('no-audio')
    expect((await rejection(probeMedia(file))).code).toBe('no-audio')
  })

  it('cancela no meio com aborted', async ({ skip }) => {
    skip(!(await webCodecsOpus()), 'o motor não codifica Opus pelo WebCodecs')
    const controller = new AbortController()
    const error = await rejection(
      convertAudio(await fixture('longo.webm'), {
        engine: 'webcodecs',
        signal: controller.signal,
        onProgress: ({ ratio }) => {
          if (ratio > 0) controller.abort()
        },
      }),
    )
    expect(error.code).toBe('aborted')
  })
})

describe('fallback ffmpeg.wasm', () => {
  it('converte AVI, que o Mediabunny não lê', async () => {
    const probe = await probeMedia(await fixture('video.avi'))
    expect(probe).toEqual({ durationSec: null, hasAudio: null, estimatedBytes: null, engine: 'ffmpeg' })
    expect((await convertFixture('video.avi')).engine).toBe('ffmpeg')
  })

  it('cancela no meio com aborted', async () => {
    const controller = new AbortController()
    const error = await rejection(
      convertAudio(await fixture('longo.avi'), {
        engine: 'ffmpeg',
        signal: controller.signal,
        onProgress: ({ ratio }) => {
          if (ratio > 0) controller.abort()
        },
      }),
    )
    expect(error.code).toBe('aborted')
  })
})
