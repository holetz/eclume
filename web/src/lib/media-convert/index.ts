// API pública da biblioteca de conversão. O app importa só daqui.
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
export type { ConvertProgress, ProgressCallback } from './progress'
