import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../app/queryClient'
import { convertAudio, probeMedia, readRecordedAt } from '../../lib/media-convert'
import { cancelUpload, runUpload, UploadError, type UploadOptions } from '../../upload/multipart'
import { recordedAtSource, toLocalInput, useImportQueue } from './useImportQueue'

vi.mock('../../lib/media-convert', async (original) => ({
  ...(await original<typeof import('../../lib/media-convert')>()),
  convertAudio: vi.fn(),
  probeMedia: vi.fn(),
  readRecordedAt: vi.fn(),
}))
vi.mock('../../upload/multipart', async (original) => ({
  ...(await original<typeof import('../../upload/multipart')>()),
  runUpload: vi.fn(),
  cancelUpload: vi.fn(),
}))

const METADATA = new Date('2026-09-19T14:02:00Z')
const MODIFIED = new Date('2026-09-23T16:00:00Z')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const converted = (name: string) => ({
  blob: new Blob([name]),
  sha256: `sha-${name}`,
  durationSec: 60,
  engine: 'webcodecs' as const,
})

let client = createQueryClient({ retry: false })
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  client = createQueryClient({ retry: false })
  vi.mocked(probeMedia).mockResolvedValue({ durationSec: 2832, hasAudio: true, estimatedBytes: 1000, engine: 'webcodecs' })
  vi.mocked(readRecordedAt).mockImplementation(async (file) =>
    (file as File).name.endsWith('.mkv')
      ? { at: MODIFIED, source: 'file_date', precision: 'minute', detail: 'lastModified' }
      : { at: METADATA, source: 'metadata', precision: 'minute', detail: 'mvhd' },
  )
  vi.mocked(cancelUpload).mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

const files = () => [
  new File(['a'], 'kickoff-guion.m4a', { lastModified: MODIFIED.getTime() }),
  new File(['b'], 'reuniao-03.mkv', { lastModified: MODIFIED.getTime() }),
]

async function ready() {
  const view = renderHook(() => useImportQueue(), { wrapper })
  act(() => view.result.current.add(files()))
  expect(view.result.current.items.map((item) => item.state.kind)).toEqual(['reading', 'reading'])
  await waitFor(() => expect(view.result.current.items.every((item) => item.state.kind === 'ready')).toBe(true))
  return view
}

describe('import queue', () => {
  it('reads the date and the duration of each file, and an edit becomes source "user"', async () => {
    const { result } = await ready()
    const [m4a, mkv] = result.current.items
    expect(m4a.date).toEqual({ value: toLocalInput(METADATA), source: 'metadata', detail: 'mvhd' })
    expect(m4a.probe?.durationSec).toBe(2832)
    expect(mkv.date.source).toBe('file_date')

    act(() => result.current.setDate(m4a.id, '2026-09-19T09:30'))
    expect(result.current.items[0].date).toMatchObject({ value: '2026-09-19T09:30', source: 'user' })
    expect(recordedAtSource(result.current.items[0].date)).toBe('user')
    expect(recordedAtSource(mkv.date)).toBe('user')
    expect(recordedAtSource(m4a.date)).toBe('file_metadata')
  })

  it('converts and uploads one file at a time, with recorded_at and the source, without a title', async () => {
    const { result } = await ready()
    const first = deferred<ReturnType<typeof converted>>()
    const upload = deferred<{ recordingId: string; deduplicated: boolean }>()
    vi.mocked(convertAudio).mockImplementationOnce(() => first.promise).mockResolvedValueOnce(converted('mkv'))
    vi.mocked(runUpload)
      .mockImplementationOnce(() => upload.promise)
      .mockResolvedValueOnce({ recordingId: 'rec-2', deduplicated: true })
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    act(() => result.current.send())
    await waitFor(() => expect(result.current.items[0].state.kind).toBe('converting'))
    expect(result.current.sending).toBe(true)
    expect(convertAudio).toHaveBeenCalledTimes(1)
    expect(result.current.items[1].state.kind).toBe('ready')

    await act(async () => first.resolve(converted('m4a')))
    await waitFor(() => expect(result.current.items[0].state.kind).toBe('uploading'))
    // While the first one uploads, the second waits.
    expect(convertAudio).toHaveBeenCalledTimes(1)
    const [sent] = vi.mocked(runUpload).mock.calls[0]
    expect(sent).toMatchObject({
      sha256: 'sha-m4a',
      filename: 'kickoff-guion.ogg',
      recordedAt: new Date(toLocalInput(METADATA)).toISOString(),
      recordedAtSource: 'file_metadata',
    })
    expect(sent.title).toBeUndefined()

    await act(async () => upload.resolve({ recordingId: 'rec-1', deduplicated: false }))
    await waitFor(() => expect(result.current.items[1].state).toEqual({ kind: 'done', recordingId: 'rec-2', deduplicated: true }))
    expect(result.current.items[0].state).toEqual({ kind: 'done', recordingId: 'rec-1', deduplicated: false })
    expect(vi.mocked(runUpload).mock.calls[1][0].recordedAtSource).toBe('user')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['recordings'] })
    expect(result.current.sending).toBe(false)

    act(() => result.current.clearFinished())
    expect(result.current.items).toHaveLength(0)
  })

  it('cancels the ongoing upload, deletes the upload and moves on to the next', async () => {
    const { result } = await ready()
    vi.mocked(convertAudio).mockResolvedValue(converted('x'))
    let signal: AbortSignal | undefined
    vi.mocked(runUpload)
      .mockImplementationOnce((_, options?: UploadOptions) => {
        options?.onCreated?.('upload-1')
        signal = options?.signal
        return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal?.reason)))
      })
      .mockResolvedValueOnce({ recordingId: 'rec-2', deduplicated: false })

    act(() => result.current.send())
    await waitFor(() => expect(result.current.items[0].state.kind).toBe('uploading'))
    act(() => result.current.cancel(result.current.items[0].id))
    expect(signal?.aborted).toBe(true)
    expect(cancelUpload).toHaveBeenCalledWith('upload-1')
    expect(result.current.items[0].state.kind).toBe('canceled')
    await waitFor(() => expect(result.current.items[1].state.kind).toBe('done'))
  })

  it('retries by resuming the upload, without converting again', async () => {
    const { result } = await ready()
    act(() => result.current.remove(result.current.items[1].id))
    expect(result.current.items).toHaveLength(1)
    vi.mocked(convertAudio).mockResolvedValue(converted('m4a'))
    vi.mocked(runUpload)
      .mockImplementationOnce(async (_, options?: UploadOptions) => {
        options?.onCreated?.('upload-9')
        throw new UploadError('part_failed', 'A parte 2 falhou.')
      })
      .mockResolvedValueOnce({ recordingId: 'rec-1', deduplicated: false })

    act(() => result.current.send())
    await waitFor(() =>
      expect(result.current.items[0].state).toEqual({ kind: 'error', message: 'A parte 2 falhou.', resumable: true }),
    )
    act(() => result.current.retry(result.current.items[0].id))
    await waitFor(() => expect(result.current.items[0].state.kind).toBe('done'))
    expect(convertAudio).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runUpload).mock.calls[1][1]?.uploadId).toBe('upload-9')
  })

  it('does not remove from the queue the file that is uploading', async () => {
    const { result } = await ready()
    vi.mocked(convertAudio).mockResolvedValue(converted('m4a'))
    vi.mocked(runUpload).mockImplementation(() => new Promise(() => {}))
    act(() => result.current.send())
    await waitFor(() => expect(result.current.items[0].state.kind).toBe('uploading'))
    act(() => result.current.remove(result.current.items[0].id))
    expect(result.current.items).toHaveLength(2)
  })
})
