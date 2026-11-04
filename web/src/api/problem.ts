// API errors in application/problem+json (RFC 9457). The UI decides by `code`, never by `title`.
import { activeLocale, i18n } from '../i18n'
import type { Schemas } from './client'

export type Problem = Schemas['Problem']
type ProblemCode = Schemas['ProblemCode']

export class ApiError extends Error {
  readonly status: number
  readonly problem: Problem | null

  constructor(status: number, problem: Problem | null) {
    super(problem?.detail ?? problem?.title ?? `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.problem = problem
  }

  get code(): string | null {
    return this.problem?.code ?? null
  }
}

function isProblem(value: unknown): value is Problem {
  return typeof value === 'object' && value !== null && typeof (value as Problem).code === 'string'
}

/** Returns `data` from an openapi-fetch call, or throws `ApiError` with the problem. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call
  if (!response.ok) throw new ApiError(response.status, isProblem(error) ? error : null)
  return data as T
}

function formatBytes(bytes: number): string {
  const number = new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 1 })
  const gib = bytes / 1024 ** 3
  if (gib >= 1) return i18n.t('errors:size.gigabytes', { value: number.format(gib) })
  return i18n.t('errors:size.megabytes', { value: number.format(Math.round(bytes / 1024 ** 2)) })
}

/** Message for an exceeded quota (`quota_exceeded`), from the problem's `quota` and `limit`. */
function quotaMessage(problem: Problem): string {
  const limit = problem.limit ?? 0
  switch (problem.quota) {
    case 'file_bytes':
    case 'storage_bytes':
      return i18n.t(`errors:quota.${problem.quota}`, { limit: formatBytes(limit) })
    case 'open_uploads':
    case 'agent_requests_24h':
      return i18n.t(`errors:quota.${problem.quota}`, { limit })
    default:
      return i18n.t('errors:quota.other')
  }
}

function isKnownCode(code: string): code is ProblemCode {
  // The active locale's bundle: only that locale is loaded, and every locale has every code.
  const codes = (i18n.getResourceBundle(activeLocale(), 'errors') as { code?: object } | undefined)?.code
  return codes !== undefined && Object.hasOwn(codes, code)
}

/** The code an unknown problem stands for, read by its HTTP status as the contract asks. */
function codeOfStatus(status: number): ProblemCode | null {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 413) return 'payload_too_large'
  if (status === 415) return 'unsupported_media_type'
  if (status === 422) return 'validation_failed'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'internal_error'
  return null
}

/**
 * The message, in the active locale, for any error coming from an API call. It reads the problem's
 * `code`; `title` and `detail` are English and informative only, never shown. An unknown code (the
 * contract only grows) is read by its HTTP status.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const problem = error.problem
    if (problem?.code === 'validation_failed') {
      const fields = problem.errors?.map((e) => `${e.field}: ${e.message}`).join('; ')
      return fields ? i18n.t('errors:validation.fields', { fields }) : i18n.t('errors:validation.form')
    }
    if (problem?.code === 'quota_exceeded') return quotaMessage(problem)
    const known = problem && isKnownCode(problem.code) ? problem.code : null
    const code = known ?? (problem ? codeOfStatus(error.status) : null)
    return code ? i18n.t(`errors:code.${code}`) : i18n.t('errors:http', { status: error.status })
  }
  if (error instanceof TypeError) return i18n.t('errors:network')
  return error instanceof Error ? error.message : i18n.t('errors:generic')
}
