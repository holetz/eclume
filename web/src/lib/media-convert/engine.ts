import type { ProgressTracker } from './progress'

/** O que cada motor recebe; o orquestrador já validou o contexto e o bitrate. */
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
}
