export type MediaConvertErrorCode =
  | 'insecure-context'
  | 'no-audio'
  | 'unsupported'
  | 'aborted'
  | 'failed'

const MESSAGES: Record<MediaConvertErrorCode, string> = {
  'insecure-context':
    'A conversão no navegador exige uma conexão segura (HTTPS). Abra o eclume pelo endereço https://.',
  'no-audio': 'O arquivo não tem faixa de áudio.',
  unsupported: 'O navegador não consegue ler ou converter este arquivo.',
  aborted: 'A conversão foi cancelada.',
  failed: 'A conversão falhou.',
}

/** The only error type that leaves the public API; `code` says what happened. */
export class MediaConvertError extends Error {
  readonly code: MediaConvertErrorCode

  constructor(code: MediaConvertErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? MESSAGES[code], options)
    this.name = 'MediaConvertError'
    this.code = code
  }
}

/** Normalizes any failure to `MediaConvertError`; an aborted signal wins over the cause. */
export function toMediaConvertError(error: unknown, signal?: AbortSignal): MediaConvertError {
  if (error instanceof MediaConvertError) return error
  if (signal?.aborted) return new MediaConvertError('aborted', undefined, { cause: error })
  return new MediaConvertError('failed', undefined, { cause: error })
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MediaConvertError('aborted', undefined, { cause: signal.reason })
}
