import { MediaConvertError } from './errors'

export interface EnvironmentReport {
  /** `isSecureContext`: without HTTPS (or localhost) there is neither WebCodecs nor `crypto.subtle`. */
  secureContext: boolean
  /** `AudioDecoder` and `AudioEncoder` exist: the WebCodecs path can be tried. */
  webCodecs: boolean
  /** `crypto.subtle` exists: the SHA-256 of the result can be computed. */
  subtleCrypto: boolean
}

type Scope = Partial<{
  isSecureContext: boolean
  AudioDecoder: unknown
  AudioEncoder: unknown
  crypto: { subtle?: unknown }
}>

export function checkEnvironment(scope: Scope = globalThis as Scope): EnvironmentReport {
  return {
    secureContext: scope.isSecureContext === true,
    webCodecs: typeof scope.AudioDecoder === 'function' && typeof scope.AudioEncoder === 'function',
    subtleCrypto: scope.crypto?.subtle != null,
  }
}

/** Fails with `insecure-context` before any read when the page is not on HTTPS. */
export function assertSecureContext(scope: Scope = globalThis as Scope): EnvironmentReport {
  const report = checkEnvironment(scope)
  if (!report.secureContext || !report.subtleCrypto) {
    throw new MediaConvertError('insecure-context')
  }
  return report
}
