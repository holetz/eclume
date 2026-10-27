import type { EngineName, EngineRequest, ProbeResult } from './engine'
import { assertSecureContext, checkEnvironment } from './environment'
import { MediaConvertError, toMediaConvertError } from './errors'
import { estimateOutputSize, normalizeBitrate } from './estimate'
import { sha256Hex } from './hash'
import { ProgressTracker, type ProgressCallback } from './progress'

export interface ConvertOptions {
  signal?: AbortSignal
  onProgress?: ProgressCallback
  /** Bits per second, from 16,000 to 64,000; default 32,000. */
  bitrate?: number
  /** `auto` tries WebCodecs and falls back to ffmpeg.wasm when it does not work. */
  engine?: 'auto' | EngineName
}

export interface ConvertResult {
  /** Mono 16 kHz Opus in Ogg (`audio/ogg; codecs=opus`). */
  blob: Blob
  /** SHA-256 of the `blob`, in lowercase hex, for the upload deduplication. */
  sha256: string
  /** Duration read back from the converted file. */
  durationSec: number
  engine: EngineName
}

export interface MediaProbe {
  durationSec: number | null
  /** `null` when the container is readable only by ffmpeg.wasm. */
  hasAudio: boolean | null
  estimatedBytes: number | null
  /** The engine `convertAudio` should use under `auto`. */
  engine: EngineName
}

export interface Engines {
  webcodecs: (request: EngineRequest) => Promise<Blob>
  ffmpeg: (request: EngineRequest) => Promise<Blob>
  probe: (file: Blob) => Promise<ProbeResult>
  measureDuration: (blob: Blob) => Promise<number>
}

type Scope = Parameters<typeof checkEnvironment>[0] & { crypto?: { subtle?: SubtleCrypto } }

// Both engines are loaded on demand: importing the library downloads neither Mediabunny
// nor ffmpeg.wasm until the first conversion.
const webcodecs = () => import('./webcodecs')
const defaultEngines: Engines = {
  webcodecs: async (request) => (await webcodecs()).convertWithWebCodecs(request),
  ffmpeg: async (request) => (await import('./ffmpeg')).convertWithFfmpeg(request),
  probe: async (file) => (await webcodecs()).probeWithWebCodecs(file),
  measureDuration: async (blob) => (await webcodecs()).measureOutputDuration(blob),
}

/** Only `unsupported` and `failed` justify trying the other engine; `no-audio` and `aborted` do not. */
function canFallBack(error: MediaConvertError): boolean {
  return error.code === 'unsupported' || error.code === 'failed'
}

export function createConverter(engines: Engines = defaultEngines, scope?: Scope) {
  async function convertAudio(file: Blob, options: ConvertOptions = {}): Promise<ConvertResult> {
    const env = assertSecureContext(scope)
    const bitrate = normalizeBitrate(options.bitrate)
    const choice = options.engine ?? 'auto'
    const order: EngineName[] =
      choice !== 'auto' ? [choice] : env.webCodecs ? ['webcodecs', 'ffmpeg'] : ['ffmpeg']

    for (const [index, name] of order.entries()) {
      // A new engine restarts the progress: the ratio is monotonic only within one attempt.
      const progress = new ProgressTracker(file.size, options.onProgress)
      try {
        const blob = await engines[name]({ file, bitrate, signal: options.signal, progress })
        progress.complete()
        const subtle = (scope ?? globalThis).crypto?.subtle
        const [sha256, durationSec] = await Promise.all([
          sha256Hex(blob, subtle),
          engines.measureDuration(blob),
        ])
        return { blob, sha256, durationSec, engine: name }
      } catch (cause) {
        const error = toMediaConvertError(cause, options.signal)
        if (index === order.length - 1 || !canFallBack(error)) throw error
      }
    }
    throw new MediaConvertError('failed')
  }

  async function probeMedia(file: Blob, options: { bitrate?: number } = {}): Promise<MediaProbe> {
    const env = checkEnvironment(scope)
    try {
      const probe = await engines.probe(file)
      if (!probe.hasAudio) throw new MediaConvertError('no-audio')
      return {
        durationSec: probe.durationSec,
        hasAudio: true,
        estimatedBytes:
          probe.durationSec === null ? null : estimateOutputSize(probe.durationSec, options.bitrate),
        engine: env.webCodecs && probe.decodable ? 'webcodecs' : 'ffmpeg',
      }
    } catch (cause) {
      const error = toMediaConvertError(cause)
      if (error.code !== 'unsupported') throw error
      return { durationSec: null, hasAudio: null, estimatedBytes: null, engine: 'ffmpeg' }
    }
  }

  return { convertAudio, probeMedia }
}

export const { convertAudio, probeMedia } = createConverter()
