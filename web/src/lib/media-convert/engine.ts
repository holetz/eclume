import type { ProgressTracker } from './progress'

/** What each engine receives; the orchestrator has already validated the context and the bitrate. */
export interface EngineRequest {
  file: Blob
  bitrate: number
  signal?: AbortSignal
  progress: ProgressTracker
}

export type EngineName = 'webcodecs' | 'ffmpeg'

export interface ProbeResult {
  durationSec: number | null
  hasAudio: boolean
  /** The browser decodes the audio track (otherwise the conversion falls back to ffmpeg.wasm). */
  decodable: boolean
}
