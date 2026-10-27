// Resumable multipart upload of contract v1 (S3 multipart with hash deduplication), without React:
// create (with sha256) → PUT of each part to the URL received → complete. Resuming means querying the
// upload and sending only the parts the storage has not confirmed yet.
import { api, type ApiClient, type Schemas } from '../api/client'
import { ApiError, unwrap } from '../api/problem'

type Upload = Schemas['Upload']
type PartUrl = Schemas['PartUrl']

export interface UploadFile {
  blob: Blob
  /** SHA-256 of the blob, in lowercase hex (the conversion's). */
  sha256: string
  filename: string
  contentType: string
  /** Without a title, the server uses the file name and auto-fill may replace it. */
  title?: string
  durationMs?: number
  /** Recording start (ISO 8601). */
  recordedAt?: string
  recordedAtSource?: Schemas['RecordedAtSource']
  kind?: Schemas['RecordingKind']
  /** Transcription language of this file (or `auto`); without it, the account's applies. */
  language?: string
}

export interface UploadProgress {
  phase: 'creating' | 'uploading' | 'completing'
  partsDone: number
  partsTotal: number
  bytesDone: number
  bytesTotal: number
}

export interface UploadOutcome {
  recordingId: string
  /** A recording with the same hash already existed: nothing was transferred. */
  deduplicated: boolean
}

export interface UploadOptions {
  /** Resumes this upload instead of creating another. */
  uploadId?: string
  signal?: AbortSignal
  onProgress?: (progress: UploadProgress) => void
  /** Called as soon as the upload exists on the server, to allow resuming or cancelling. */
  onCreated?: (uploadId: string) => void
  concurrency?: number
  maxAttempts?: number
  retryDelayMs?: (attempt: number) => number
  client?: ApiClient
}

export type UploadErrorCode = 'upload_gone' | 'part_failed' | 'missing_etag'

export class UploadError extends Error {
  readonly code: UploadErrorCode

  constructor(code: UploadErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'UploadError'
    this.code = code
  }
}

const DEFAULT_DELAYS = [1000, 3000, 8000]

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

export async function runUpload(file: UploadFile, options: UploadOptions = {}): Promise<UploadOutcome> {
  // An own controller, linked to the caller's: the failure of one part also stops the others.
  const local = new AbortController()
  const stop = () => local.abort(options.signal?.reason)
  if (options.signal?.aborted) stop()
  options.signal?.addEventListener('abort', stop, { once: true })
  try {
    return await transfer(file, options, local)
  } finally {
    options.signal?.removeEventListener('abort', stop)
  }
}

async function transfer(file: UploadFile, options: UploadOptions, local: AbortController): Promise<UploadOutcome> {
  const client = options.client ?? api
  const { onProgress } = options
  const signal = local.signal
  const concurrency = options.concurrency ?? 3
  const maxAttempts = options.maxAttempts ?? 3
  const retryDelay = options.retryDelayMs ?? ((attempt: number) => DEFAULT_DELAYS[attempt - 1] ?? 8000)
  const size = file.blob.size

  onProgress?.({ phase: 'creating', partsDone: 0, partsTotal: 0, bytesDone: 0, bytesTotal: size })

  let current: Upload
  if (options.uploadId) {
    current = await unwrap(
      client.GET('/api/v1/uploads/{upload_id}', { params: { path: { upload_id: options.uploadId } }, signal }),
    )
  } else {
    current = await unwrap(
      client.POST('/api/v1/uploads', {
        body: {
          filename: file.filename,
          content_type: file.contentType,
          size_bytes: size,
          sha256: file.sha256,
          source: 'upload',
          ...(file.title ? { title: file.title } : {}),
          ...(file.durationMs != null ? { duration_ms: Math.round(file.durationMs) } : {}),
          ...(file.recordedAt ? { recorded_at: file.recordedAt } : {}),
          ...(file.recordedAtSource ? { recorded_at_source: file.recordedAtSource } : {}),
          ...(file.kind ? { kind: file.kind } : {}),
          language: file.language,
        },
        signal,
      }),
    )
  }

  if (current.status === 'deduplicated' && current.recording_id) {
    return { recordingId: current.recording_id, deduplicated: true }
  }
  if (current.status === 'completed' && current.recording_id) {
    return { recordingId: current.recording_id, deduplicated: false }
  }
  if (current.status !== 'in_progress') {
    throw new UploadError('upload_gone', 'O envio expirou ou foi abortado. Recomece o import.')
  }
  options.onCreated?.(current.id)

  const uploadId = current.id
  const partSize = current.part_size
  // The number of parts comes from the file size and the part_size fixed by the server.
  const partCount = Math.max(1, Math.ceil(size / partSize))
  const partBytes = (n: number) => Math.min(n * partSize, size) - (n - 1) * partSize

  const etags = new Map<number, string>()
  for (const part of current.parts_received) {
    if (part.part_number <= partCount) etags.set(part.part_number, part.etag)
  }
  const urls = new Map<number, PartUrl>()
  for (const part of current.parts) urls.set(part.part_number, part)

  let bytesDone = 0
  for (const n of etags.keys()) bytesDone += partBytes(n)
  const report = (phase: UploadProgress['phase']) =>
    onProgress?.({ phase, partsDone: etags.size, partsTotal: partCount, bytesDone, bytesTotal: size })

  async function requestUrls(numbers: number[]): Promise<void> {
    for (let i = 0; i < numbers.length; i += 1000) {
      const { parts } = await unwrap(
        client.POST('/api/v1/uploads/{upload_id}/part-urls', {
          params: { path: { upload_id: uploadId } },
          body: { part_numbers: numbers.slice(i, i + 1000) },
          signal,
        }),
      )
      for (const part of parts) urls.set(part.part_number, part)
    }
  }

  const pending: number[] = []
  for (let n = 1; n <= partCount; n++) if (!etags.has(n)) pending.push(n)
  const withoutUrl = pending.filter((n) => !urls.has(n))
  if (withoutUrl.length > 0) await requestUrls(withoutUrl)

  report('uploading')

  async function sendPart(n: number): Promise<void> {
    const body = file.blob.slice((n - 1) * partSize, Math.min(n * partSize, size))
    for (let attempt = 1; ; attempt++) {
      const target = urls.get(n)
      if (!target) throw new UploadError('part_failed', `O servidor não deu URL para a parte ${n}.`)
      let response: Response | null = null
      let failure: unknown = null
      try {
        // The part URL authorizes itself; the same-origin cookie goes along and is ignored.
        response = await fetch(target.url, {
          method: target.method,
          headers: target.headers,
          body,
          signal,
          credentials: 'same-origin',
        })
      } catch (error) {
        if (signal.aborted) throw signal.reason
        failure = error
      }
      if (response?.ok) {
        const etag = response.headers.get('ETag')
        if (!etag) {
          throw new UploadError(
            'missing_etag',
            'O armazenamento não devolveu o ETag da parte. Confira o CORS (Access-Control-Expose-Headers).',
          )
        }
        etags.set(n, etag)
        bytesDone += body.size
        report('uploading')
        return
      }
      if (attempt >= maxAttempts || (response && response.status !== 403 && !isRetryableStatus(response.status))) {
        throw new UploadError(
          'part_failed',
          response ? `A parte ${n} foi recusada (HTTP ${response.status}).` : `A parte ${n} não chegou ao servidor.`,
          { cause: failure },
        )
      }
      // 403: URL expired or refused — request a new one for the part and try again.
      if (response?.status === 403) await requestUrls([n])
      else await wait(retryDelay(attempt), signal)
    }
  }

  const queue = [...pending]
  async function worker(): Promise<void> {
    try {
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) await sendPart(n)
    } catch (error) {
      if (!signal.aborted) local.abort(error)
      throw error
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))

  report('completing')
  const recording = await unwrap(
    client.POST('/api/v1/uploads/{upload_id}/complete', {
      params: { path: { upload_id: uploadId } },
      body: {
        parts: [...etags].sort(([a], [b]) => a - b).map(([part_number, etag]) => ({ part_number, etag })),
      },
      signal,
    }),
  )
  return { recordingId: recording.id, deduplicated: false }
}

/** Aborts the upload on the server and discards the parts. An upload that no longer exists is not an error. */
export async function cancelUpload(uploadId: string, client: ApiClient = api): Promise<void> {
  const { response } = await client.DELETE('/api/v1/uploads/{upload_id}', {
    params: { path: { upload_id: uploadId } },
  })
  if (!response.ok && response.status !== 404) throw new ApiError(response.status, null)
}
