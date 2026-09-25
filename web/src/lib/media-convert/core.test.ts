// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { assertSecureContext, checkEnvironment } from './environment'
import { MediaConvertError, throwIfAborted, toMediaConvertError } from './errors'
import { DEFAULT_BITRATE, estimateOutputSize, normalizeBitrate } from './estimate'
import { sha256Hex } from './hash'
import { ProgressTracker } from './progress'

const secure = {
  isSecureContext: true,
  AudioDecoder: function AudioDecoder() {},
  AudioEncoder: function AudioEncoder() {},
  crypto: { subtle: {} },
}

describe('checkEnvironment', () => {
  it('reconhece um contexto seguro com WebCodecs', () => {
    expect(checkEnvironment(secure)).toEqual({
      secureContext: true,
      webCodecs: true,
      subtleCrypto: true,
    })
  })

  it('reporta a ausência de cada capacidade', () => {
    expect(checkEnvironment({ isSecureContext: false })).toEqual({
      secureContext: false,
      webCodecs: false,
      subtleCrypto: false,
    })
  })

  it('falha com insecure-context em HTTP', () => {
    const error = (() => {
      try {
        assertSecureContext({ ...secure, isSecureContext: false })
      } catch (e) {
        return e
      }
    })()
    expect(error).toBeInstanceOf(MediaConvertError)
    expect((error as MediaConvertError).code).toBe('insecure-context')
    expect((error as MediaConvertError).message).toMatch(/HTTPS/)
  })

  it('não falha em contexto seguro sem WebCodecs (o fallback ainda serve)', () => {
    expect(() => assertSecureContext({ isSecureContext: true, crypto: { subtle: {} } })).not.toThrow()
  })
})

describe('estimateOutputSize', () => {
  it('fica na ordem de 15 MB por hora no bitrate padrão', () => {
    const bytes = estimateOutputSize(3600)
    expect(DEFAULT_BITRATE).toBe(32_000)
    expect(bytes).toBeGreaterThan(14_000_000)
    expect(bytes).toBeLessThan(15_000_000)
  })

  it('escala com o bitrate e começa pelos cabeçalhos', () => {
    expect(estimateOutputSize(0)).toBe(1024)
    expect(estimateOutputSize(60, 16_000)).toBeLessThan(estimateOutputSize(60, 32_000))
  })

  it('recusa entradas inválidas', () => {
    expect(() => estimateOutputSize(-1)).toThrow(RangeError)
    expect(() => estimateOutputSize(Number.NaN)).toThrow(RangeError)
    expect(() => normalizeBitrate(8_000)).toThrow(RangeError)
    expect(() => normalizeBitrate(128_000)).toThrow(RangeError)
    expect(normalizeBitrate(24_000.4)).toBe(24_000)
  })
})

describe('sha256Hex', () => {
  const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

  it('produz o hex minúsculo do vetor conhecido', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(abc)
  })

  it('aceita Blob', async () => {
    expect(await sha256Hex(new Blob(['a', 'bc']))).toBe(abc)
  })
})

describe('ProgressTracker', () => {
  it('é monótono, limitado e termina em 1', () => {
    const seen: number[] = []
    const tracker = new ProgressTracker(100, (p) => seen.push(p.ratio))
    tracker.setRatio(0.4)
    tracker.setRatio(0.2)
    tracker.setRatio(7)
    tracker.setRatio(Number.NaN)
    tracker.complete()
    expect(seen).toEqual([0.4, 0.4, 1, 1])
  })

  it('soma os bytes lidos até o total', () => {
    const onProgress = vi.fn()
    const tracker = new ProgressTracker(100, onProgress)
    tracker.addBytesRead(60)
    tracker.addBytesRead(60)
    expect(tracker.snapshot()).toEqual({ ratio: 0, bytesRead: 100, bytesTotal: 100 })
    expect(onProgress).toHaveBeenCalledTimes(2)
  })
})

describe('erros', () => {
  it('normaliza falhas e dá prioridade ao abort', () => {
    const cause = new Error('x')
    expect(toMediaConvertError(cause).code).toBe('failed')
    expect(toMediaConvertError(cause).cause).toBe(cause)
    expect(toMediaConvertError(cause, AbortSignal.abort()).code).toBe('aborted')
    const own = new MediaConvertError('no-audio')
    expect(toMediaConvertError(own, AbortSignal.abort())).toBe(own)
  })

  it('throwIfAborted só lança com o sinal abortado', () => {
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow()
    expect(() => throwIfAborted(AbortSignal.abort())).toThrow(MediaConvertError)
  })
})

describe('ProgressTracker com bytes pela razão', () => {
  it('aceita a contagem de bytes dada pelo motor, sem recuar', () => {
    const tracker = new ProgressTracker(1000)
    tracker.setRatio(0.5, 500)
    tracker.setRatio(0.4, 400)
    tracker.setRatio(0.9, 5000)
    expect(tracker.snapshot()).toEqual({ ratio: 0.9, bytesRead: 1000, bytesTotal: 1000 })
  })
})
