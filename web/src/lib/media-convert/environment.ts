import { MediaConvertError } from './errors'

export interface EnvironmentReport {
  /** `isSecureContext`: sem HTTPS (ou localhost) não há WebCodecs nem `crypto.subtle`. */
  secureContext: boolean
  /** `AudioDecoder` e `AudioEncoder` existem: a via WebCodecs pode ser tentada. */
  webCodecs: boolean
  /** `crypto.subtle` existe: o SHA-256 do resultado pode ser calculado. */
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

/** Falha com `insecure-context` antes de qualquer leitura quando a página não está em HTTPS. */
export function assertSecureContext(scope: Scope = globalThis as Scope): EnvironmentReport {
  const report = checkEnvironment(scope)
  if (!report.secureContext || !report.subtleCrypto) {
    throw new MediaConvertError('insecure-context')
  }
  return report
}
