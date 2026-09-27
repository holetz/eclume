// API pública da biblioteca de conversão. O app importa só daqui.
export {
  convertAudio,
  probeMedia,
  type ConvertOptions,
  type ConvertResult,
  type MediaProbe,
} from './convert'
export type { EngineName } from './engine'
export { checkEnvironment, type EnvironmentReport } from './environment'
export { MediaConvertError, type MediaConvertErrorCode } from './errors'
export {
  DEFAULT_BITRATE,
  estimateOutputSize,
  MAX_BITRATE,
  MIN_BITRATE,
  OUTPUT_FORMAT,
} from './estimate'
export { sha256Hex } from './hash'
export { readRecordedAt, type RecordedAt } from './recorded-at'
export type { ConvertProgress, ProgressCallback } from './progress'
