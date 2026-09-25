import type { EngineName, EngineRequest, ProbeResult } from './engine'
import { assertSecureContext, checkEnvironment } from './environment'
import { MediaConvertError, toMediaConvertError } from './errors'
import { estimateOutputSize, normalizeBitrate } from './estimate'
import { sha256Hex } from './hash'
import { ProgressTracker, type ProgressCallback } from './progress'

export interface ConvertOptions {
  signal?: AbortSignal
  onProgress?: ProgressCallback
  /** Bits por segundo, de 16 000 a 64 000; padrão 32 000. */
  bitrate?: number
  /** `auto` tenta o WebCodecs e cai para o ffmpeg.wasm quando ele não serve. */
  engine?: 'auto' | EngineName
}

export interface ConvertResult {
  /** Opus mono 16 kHz em Ogg (`audio/ogg; codecs=opus`). */
  blob: Blob
  /** SHA-256 do `blob`, em hex minúsculo, para a dedup do upload. */
  sha256: string
  /** Duração relida do arquivo convertido. */
  durationSec: number
  engine: EngineName
}

export interface MediaProbe {
  durationSec: number | null
  /** `null` quando o contêiner só é legível pelo ffmpeg.wasm. */
  hasAudio: boolean | null
  estimatedBytes: number | null
  /** O motor que `convertAudio` deve usar em `auto`. */
  engine: EngineName
}

export interface Engines {
  webcodecs: (request: EngineRequest) => Promise<Blob>
  ffmpeg: (request: EngineRequest) => Promise<Blob>
  probe: (file: Blob) => Promise<ProbeResult>
  measureDuration: (blob: Blob) => Promise<number>
}

type Scope = Parameters<typeof checkEnvironment>[0] & { crypto?: { subtle?: SubtleCrypto } }

// Os dois motores são carregados sob demanda: importar a biblioteca não baixa o Mediabunny
// nem o ffmpeg.wasm até a primeira conversão.
const webcodecs = () => import('./webcodecs')
const defaultEngines: Engines = {
  webcodecs: async (request) => (await webcodecs()).convertWithWebCodecs(request),
  ffmpeg: async (request) => (await import('./ffmpeg')).convertWithFfmpeg(request),
  probe: async (file) => (await webcodecs()).probeWithWebCodecs(file),
  measureDuration: async (blob) => (await webcodecs()).measureOutputDuration(blob),
}

/** Só `unsupported` e `failed` justificam tentar o outro motor; `no-audio` e `aborted`, não. */
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
      // Um motor novo recomeça o progresso: a razão só é monótona dentro de uma tentativa.
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
