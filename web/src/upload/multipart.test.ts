// @vitest-environment node
// O Blob do jsdom não serve de corpo para o fetch do Node; no ambiente node, os dois são nativos.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../api/client'
import { ApiError } from '../api/problem'
import { fixtures } from '../test/fixtures'
import { empty, json, mockFetch, problem } from '../test/http'
import { cancelUpload, runUpload, UploadError, type UploadFile, type UploadProgress } from './multipart'

const UPLOAD = '01928f3a-1c00-7a00-8000-000000000601'
const BASE = `http://127.0.0.1:4010/api/v1/uploads/${UPLOAD}/parts`

afterEach(() => vi.unstubAllGlobals())

/** Arquivo de 10 bytes em partes de 4: três partes (4, 4 e 2 bytes). */
function file(): UploadFile {
  return {
    blob: new Blob(['0123456789'], { type: 'audio/ogg' }),
    sha256: 'e8a08c6af61744061af021cbb0b9acdf8c408b203cd2f3e2ac455e72e067aee5',
    filename: 'reuniao.ogg',
    contentType: 'audio/ogg; codecs=opus',
    title: 'Reunião',
    durationMs: 1234.4,
  }
}

function partUrl(n: number) {
  return {
    part_number: n,
    method: 'PUT' as const,
    url: `${BASE}/${n}`,
    headers: { 'Content-Type': 'application/octet-stream' },
    expires_at: '2099-01-01T00:00:00Z',
  }
}

function created(parts = [1, 2, 3]) {
  return { ...fixtures.uploadCreated(), size_bytes: 10, part_size: 4, part_count: 3, parts: parts.map(partUrl) }
}

const putOk = async (request: Request, params: Record<string, string>) =>
  empty(200, { ETag: `"etag-${params.n}-${await request.text()}"` })

const client = createApiClient('http://localhost')
const options = { client, retryDelayMs: () => 0 }

describe('runUpload', () => {
  it('deduplica: com o hash já conhecido, nada é enviado', async () => {
    const http = mockFetch({ 'POST /api/v1/uploads': () => fixtures.uploadDeduplicated() })
    const outcome = await runUpload(file(), options)
    expect(outcome).toEqual({ recordingId: '01928f3a-1c00-7a00-8000-000000000401', deduplicated: true })
    expect(http.calls).toHaveLength(1)
    expect(await http.calls[0].json()).toEqual({
      filename: 'reuniao.ogg',
      content_type: 'audio/ogg; codecs=opus',
      size_bytes: 10,
      sha256: file().sha256,
      source: 'upload',
      title: 'Reunião',
      duration_ms: 1234,
    })
  })

  it('cria, envia as partes com os headers recebidos e conclui com os ETags em ordem', async () => {
    const http = mockFetch({
      'POST /api/v1/uploads': () => json(created(), 201),
      'PUT /api/v1/uploads/:id/parts/:n': putOk,
      'POST /api/v1/uploads/:id/complete': () => json(fixtures.recordingQueued(), 201),
    })
    const progress: UploadProgress[] = []
    const onCreated = vi.fn()
    const outcome = await runUpload(file(), { ...options, onProgress: (p) => progress.push(p), onCreated })

    expect(outcome).toEqual({ recordingId: fixtures.recordingQueued().id, deduplicated: false })
    expect(onCreated).toHaveBeenCalledWith(UPLOAD)
    const puts = http.requests('PUT /api/v1/uploads/:id/parts/:n')
    expect(puts).toHaveLength(3)
    expect(puts[0].headers.get('Content-Type')).toBe('application/octet-stream')
    const complete = await http.requests('POST /api/v1/uploads/:id/complete')[0].json()
    expect(complete).toEqual({
      parts: [
        { part_number: 1, etag: '"etag-1-0123"' },
        { part_number: 2, etag: '"etag-2-4567"' },
        { part_number: 3, etag: '"etag-3-89"' },
      ],
    })
    expect(progress.at(-1)).toEqual({ phase: 'completing', partsDone: 3, partsTotal: 3, bytesDone: 10, bytesTotal: 10 })
    expect(progress.filter((p) => p.phase === 'uploading').map((p) => p.bytesDone).at(-1)).toBe(10)
  })

  it('pede URLs para as partes que vieram sem', async () => {
    const http = mockFetch({
      'POST /api/v1/uploads': () => json(created([1]), 201),
      'POST /api/v1/uploads/:id/part-urls': () => ({ parts: [partUrl(2), partUrl(3)] }),
      'PUT /api/v1/uploads/:id/parts/:n': putOk,
      'POST /api/v1/uploads/:id/complete': () => json(fixtures.recordingQueued(), 201),
    })
    await runUpload(file(), options)
    expect(await http.requests('POST /api/v1/uploads/:id/part-urls')[0].json()).toEqual({ part_numbers: [2, 3] })
    expect(http.requests('PUT /api/v1/uploads/:id/parts/:n')).toHaveLength(3)
  })

  it('retoma: consulta o upload e sobe só as partes que faltam', async () => {
    const inProgress = {
      ...fixtures.uploadInProgress(),
      size_bytes: 10,
      part_size: 4,
      parts_received: [{ part_number: 1, etag: '"ja-recebida"', size_bytes: 4 }],
      parts: [],
    }
    const http = mockFetch({
      'GET /api/v1/uploads/:id': () => inProgress,
      'POST /api/v1/uploads/:id/part-urls': () => ({ parts: [partUrl(2), partUrl(3)] }),
      'PUT /api/v1/uploads/:id/parts/:n': putOk,
      'POST /api/v1/uploads/:id/complete': () => json(fixtures.recordingQueued(), 201),
    })
    const progress: UploadProgress[] = []
    await runUpload(file(), { ...options, uploadId: UPLOAD, onProgress: (p) => progress.push(p) })
    expect(http.requests('POST /api/v1/uploads')).toHaveLength(0)
    const puts = http.requests('PUT /api/v1/uploads/:id/parts/:n').map((r) => new URL(r.url).pathname.split('/').at(-1))
    expect(puts.sort()).toEqual(['2', '3'])
    const complete = await http.requests('POST /api/v1/uploads/:id/complete')[0].json()
    expect(complete.parts[0]).toEqual({ part_number: 1, etag: '"ja-recebida"' })
    expect(progress.find((p) => p.phase === 'uploading')?.bytesDone).toBe(4)
  })

  it('URL recusada (403) é renovada e a parte é reenviada', async () => {
    let refused = false
    const http = mockFetch({
      'POST /api/v1/uploads': () => json(created(), 201),
      'POST /api/v1/uploads/:id/part-urls': () => ({ parts: [partUrl(2)] }),
      'PUT /api/v1/uploads/:id/parts/:n': (request, params) => {
        if (params.n === '2' && !refused) {
          refused = true
          return problem('forbidden', 403)
        }
        return putOk(request, params)
      },
      'POST /api/v1/uploads/:id/complete': () => json(fixtures.recordingQueued(), 201),
    })
    await runUpload(file(), options)
    expect(await http.requests('POST /api/v1/uploads/:id/part-urls')[0].json()).toEqual({ part_numbers: [2] })
    expect(http.requests('PUT /api/v1/uploads/:id/parts/:n')).toHaveLength(4)
  })

  it('tenta de novo em falha de rede e 5xx, e desiste depois do limite', async () => {
    let failures = 0
    mockFetch({
      'POST /api/v1/uploads': () => json(created(), 201),
      'PUT /api/v1/uploads/:id/parts/:n': (request, params) => {
        if (params.n === '3') {
          failures++
          if (failures === 1) throw new TypeError('Failed to fetch')
          return empty(503)
        }
        return putOk(request, params)
      },
    })
    const error = await runUpload(file(), options).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(UploadError)
    expect((error as UploadError).code).toBe('part_failed')
    expect(failures).toBe(3)
  })

  it('para e rejeita quando o chamador cancela', async () => {
    const controller = new AbortController()
    mockFetch({
      'POST /api/v1/uploads': () => json(created(), 201),
      'PUT /api/v1/uploads/:id/parts/:n': (request) =>
        new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason))),
    })
    const pending = runUpload(file(), { ...options, signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort(new DOMException('Pausado', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('exige o ETag da parte e recusa upload expirado', async () => {
    mockFetch({
      'POST /api/v1/uploads': () => json(created(), 201),
      'PUT /api/v1/uploads/:id/parts/:n': () => empty(200),
    })
    await expect(runUpload(file(), options)).rejects.toMatchObject({ code: 'missing_etag' })

    mockFetch({ 'GET /api/v1/uploads/:id': () => ({ ...fixtures.uploadInProgress(), status: 'expired' }) })
    await expect(runUpload(file(), { ...options, uploadId: UPLOAD })).rejects.toMatchObject({ code: 'upload_gone' })
  })

  it('propaga o problem do complete', async () => {
    mockFetch({
      'POST /api/v1/uploads': () => json(created(), 201),
      'PUT /api/v1/uploads/:id/parts/:n': putOk,
      'POST /api/v1/uploads/:id/complete': () => problem('conflict', 409),
    })
    const error = await runUpload(file(), options).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('conflict')
  })
})

describe('cancelUpload', () => {
  it('aborta no servidor e tolera upload já inexistente', async () => {
    const http = mockFetch({ 'DELETE /api/v1/uploads/:id': () => empty(204) })
    await cancelUpload(UPLOAD, client)
    expect(http.requests('DELETE /api/v1/uploads/:id')).toHaveLength(1)
    mockFetch({ 'DELETE /api/v1/uploads/:id': () => problem('not_found', 404) })
    await expect(cancelUpload(UPLOAD, client)).resolves.toBeUndefined()
  })
})
