// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createConverter, type Engines } from './convert'
import type { EngineRequest } from './engine'
import { MediaConvertError } from './errors'
import { sha256Hex } from './hash'

const scope = {
  isSecureContext: true,
  AudioDecoder: function AudioDecoder() {},
  AudioEncoder: function AudioEncoder() {},
  crypto: globalThis.crypto,
}
const input = new Blob([new Uint8Array(1000)])
const opus = new Blob(['OggS…'], { type: 'audio/ogg; codecs=opus' })

function engines(overrides: Partial<Engines> = {}): Engines {
  return {
    webcodecs: vi.fn(async ({ progress }: EngineRequest) => {
      progress.addBytesRead(400)
      progress.setRatio(0.5)
      return opus
    }),
    ffmpeg: vi.fn(async () => opus),
    probe: vi.fn(async () => ({ durationSec: 60, hasAudio: true, decodable: true })),
    measureDuration: vi.fn(async () => 10),
    ...overrides,
  }
}

async function rejection(promise: Promise<unknown>): Promise<MediaConvertError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(MediaConvertError)
    return error as MediaConvertError
  }
  throw new Error('expected a rejection')
}

describe('convertAudio', () => {
  it('converts through WebCodecs, with hash, duration and progress up to 1', async () => {
    const e = engines()
    const onProgress = vi.fn()
    const { convertAudio } = createConverter(e, scope)
    const result = await convertAudio(input, { onProgress })
    expect(result).toEqual({
      blob: opus,
      sha256: await sha256Hex(opus),
      durationSec: 10,
      engine: 'webcodecs',
    })
    expect(e.ffmpeg).not.toHaveBeenCalled()
    expect(vi.mocked(e.webcodecs).mock.calls[0][0].bitrate).toBe(32_000)
    expect(onProgress).toHaveBeenLastCalledWith({ ratio: 1, bytesRead: 400, bytesTotal: 1000 })
  })

  it.each(['unsupported', 'failed'] as const)('falls back to ffmpeg when WebCodecs gives %s', async (code) => {
    const e = engines({ webcodecs: vi.fn(async () => Promise.reject(new MediaConvertError(code))) })
    const result = await createConverter(e, scope).convertAudio(input, { bitrate: 24_000 })
    expect(result.engine).toBe('ffmpeg')
    expect(vi.mocked(e.ffmpeg).mock.calls[0][0].bitrate).toBe(24_000)
  })

  it('does not fall back to ffmpeg without an audio track', async () => {
    const e = engines({
      webcodecs: vi.fn(async () => Promise.reject(new MediaConvertError('no-audio'))),
    })
    expect((await rejection(createConverter(e, scope).convertAudio(input))).code).toBe('no-audio')
    expect(e.ffmpeg).not.toHaveBeenCalled()
  })

  it('uses only ffmpeg when there is no WebCodecs', async () => {
    const e = engines()
    const result = await createConverter(e, { ...scope, AudioEncoder: undefined }).convertAudio(input)
    expect(result.engine).toBe('ffmpeg')
    expect(e.webcodecs).not.toHaveBeenCalled()
  })

  it('honours the chosen engine, without fallback', async () => {
    const e = engines({ ffmpeg: vi.fn(async () => Promise.reject(new Error('boom'))) })
    expect((await rejection(createConverter(e, scope).convertAudio(input, { engine: 'ffmpeg' }))).code).toBe('failed')
    expect(e.webcodecs).not.toHaveBeenCalled()
  })

  it('rejects with aborted and does not try the fallback', async () => {
    const controller = new AbortController()
    const e = engines({
      webcodecs: vi.fn(async () => {
        controller.abort()
        throw new Error('cancelled')
      }),
    })
    const error = await rejection(
      createConverter(e, scope).convertAudio(input, { signal: controller.signal }),
    )
    expect(error.code).toBe('aborted')
    expect(e.ffmpeg).not.toHaveBeenCalled()
  })

  it('refuses HTTP before reading the file', async () => {
    const e = engines()
    const error = await rejection(
      createConverter(e, { ...scope, isSecureContext: false }).convertAudio(input),
    )
    expect(error.code).toBe('insecure-context')
    expect(e.webcodecs).not.toHaveBeenCalled()
    expect(e.ffmpeg).not.toHaveBeenCalled()
  })
})

describe('probeMedia', () => {
  it('estimates the size and predicts the engine', async () => {
    const probe = await createConverter(engines(), scope).probeMedia(input)
    expect(probe).toMatchObject({ durationSec: 60, hasAudio: true, engine: 'webcodecs' })
    expect(probe.estimatedBytes).toBeGreaterThan(240_000)
  })

  it('predicts ffmpeg for audio the browser does not decode', async () => {
    const e = engines({ probe: vi.fn(async () => ({ durationSec: 5, hasAudio: true, decodable: false })) })
    expect((await createConverter(e, scope).probeMedia(input)).engine).toBe('ffmpeg')
  })

  it('returns the unknown for containers only ffmpeg reads', async () => {
    const e = engines({ probe: vi.fn(async () => Promise.reject(new MediaConvertError('unsupported'))) })
    expect(await createConverter(e, scope).probeMedia(input)).toEqual({
      durationSec: null,
      hasAudio: null,
      estimatedBytes: null,
      engine: 'ffmpeg',
    })
  })

  it('rejects a file without audio', async () => {
    const e = engines({ probe: vi.fn(async () => ({ durationSec: 5, hasAudio: false, decodable: false })) })
    expect((await rejection(createConverter(e, scope).probeMedia(input))).code).toBe('no-audio')
  })
})
