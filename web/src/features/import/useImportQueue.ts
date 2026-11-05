// The import queue: several files, each with the recording start read from the metadata and confirmed
// by the person, converted and uploaded one at a time. The converted audio stays in memory while the
// page is open, to resume the upload that failed.
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '../../api/problem'
import {
  convertAudio,
  MediaConvertError,
  OUTPUT_FORMAT,
  probeMedia,
  readRecordedAt,
  type MediaProbe,
} from '../../lib/media-convert'
import { cancelUpload, runUpload, UploadError, type UploadProgress } from '../../upload/multipart'

type ItemState =
  | { kind: 'reading' }
  | { kind: 'ready' }
  | { kind: 'converting'; ratio: number }
  | { kind: 'uploading'; progress: UploadProgress | null }
  | { kind: 'done'; recordingId: string; deduplicated: boolean }
  | { kind: 'error'; message: string; resumable: boolean }
  | { kind: 'canceled' }

export interface ImportDate {
  /** Value of `<input type=datetime-local>`, in local time: `YYYY-MM-DDTHH:MM`. */
  value: string
  /**
   * `metadata` (read from the file), `metadata_day` (only the day in the file, the time from the modification),
   * `file_date` (modification date) or `user` (edited).
   */
  source: 'metadata' | 'metadata_day' | 'file_date' | 'user'
  detail: string
}

export interface ImportItem {
  id: string
  file: File
  probe: MediaProbe | null
  date: ImportDate
  /** Transcription language of this file (or `auto`); without it, the account's applies. */
  language?: string
  state: ItemState
}

export interface ImportQueue {
  items: ImportItem[]
  /** A file is converting or uploading. */
  sending: boolean
  add: (files: Iterable<File>) => void
  setDate: (id: string, value: string) => void
  /** Changes a file in the queue (the language, in the modal). */
  edit: (id: string, change: (item: ImportItem) => ImportItem) => void
  remove: (id: string) => void
  send: () => void
  cancel: (id: string) => void
  retry: (id: string) => void
  /** Removes from the queue what has already finished (uploaded or canceled). */
  clearFinished: () => void
}

interface Runtime {
  converted?: { blob: Blob; sha256: string; durationSec: number }
  uploadId?: string
  controller?: AbortController
  canceled?: boolean
}

/** File name without the extension, for the Opus name. */
function fileStem(name: string): string {
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? name.slice(0, dot) : name).trim() || 'gravação'
}

/** `YYYY-MM-DDTHH:MM` in local time, the `datetime-local` format. */
export function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The source the upload sends: from the metadata without editing, or confirmed by the person. */
export function recordedAtSource(date: ImportDate): 'file_metadata' | 'user' {
  return date.source === 'metadata' || date.source === 'metadata_day' ? 'file_metadata' : 'user'
}

function describe(error: unknown): string {
  if (error instanceof MediaConvertError || error instanceof UploadError) return error.message
  return errorMessage(error)
}

const BUSY: ItemState['kind'][] = ['converting', 'uploading']
let nextId = 0

export function useImportQueue(): ImportQueue {
  const queryClient = useQueryClient()
  const [items, setItems] = useState<ImportItem[]>([])
  const itemsRef = useRef(items)
  const runtime = useRef(new Map<string, Runtime>())
  const running = useRef(false)

  // The queue lives in the ref, the source of truth of the upload loop (which does not wait for React to render); the
  // state only mirrors the ref for the screen.
  const commit = useCallback((next: ImportItem[]) => {
    itemsRef.current = next
    setItems(next)
  }, [])
  const update = useCallback(
    (id: string, change: (item: ImportItem) => ImportItem) =>
      commit(itemsRef.current.map((item) => (item.id === id ? change(item) : item))),
    [commit],
  )
  const setState = useCallback((id: string, state: ItemState) => update(id, (item) => ({ ...item, state })), [update])

  useEffect(() => {
    const map = runtime.current
    return () => map.forEach((entry) => entry.controller?.abort())
  }, [])

  const add = useCallback(
    (files: Iterable<File>) => {
      const added = [...files].map<ImportItem>((file) => ({
        id: `arquivo-${++nextId}`,
        file,
        probe: null,
        date: { value: toLocalInput(new Date(file.lastModified)), source: 'file_date', detail: 'lastModified' },
        state: { kind: 'reading' },
      }))
      commit([...itemsRef.current, ...added])
      for (const item of added) {
        runtime.current.set(item.id, {})
        const probe = probeMedia(item.file).catch(() => null)
        const date = readRecordedAt(item.file)
        void Promise.all([probe, date]).then(([probed, read]) =>
          update(item.id, (current) => ({
            ...current,
            probe: probed,
            // A date already edited by the person is not replaced by the reading.
            date:
              current.date.source === 'user'
                ? current.date
                : {
                    value: toLocalInput(read.at),
                    source: read.precision === 'day' ? 'metadata_day' : read.source,
                    detail: read.detail,
                  },
            state: current.state.kind === 'reading' ? { kind: 'ready' } : current.state,
          })),
        )
      }
    },
    [commit, update],
  )

  const setDate = useCallback(
    (id: string, value: string) => update(id, (item) => ({ ...item, date: { ...item.date, value, source: 'user' } })),
    [update],
  )

  const remove = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((candidate) => candidate.id === id)
      if (!item || BUSY.includes(item.state.kind)) return
      runtime.current.delete(id)
      commit(itemsRef.current.filter((candidate) => candidate.id !== id))
    },
    [commit],
  )

  /** Converts (if not yet) and uploads a file; returns when it finishes, fails or is canceled. */
  const process = useCallback(
    async (id: string) => {
      const entry = runtime.current.get(id) ?? {}
      runtime.current.set(id, entry)
      entry.canceled = false
      const controller = new AbortController()
      entry.controller = controller
      const item = itemsRef.current.find((candidate) => candidate.id === id)
      if (!item) return
      try {
        if (!entry.converted) {
          setState(id, { kind: 'converting', ratio: 0 })
          entry.converted = await convertAudio(item.file, {
            signal: controller.signal,
            onProgress: ({ ratio }) => setState(id, { kind: 'converting', ratio }),
          })
        }
        setState(id, { kind: 'uploading', progress: null })
        const audio = entry.converted
        const outcome = await runUpload(
          {
            blob: audio.blob,
            sha256: audio.sha256,
            filename: `${fileStem(item.file.name)}${OUTPUT_FORMAT.extension}`,
            contentType: OUTPUT_FORMAT.mimeType,
            durationMs: audio.durationSec * 1000,
            recordedAt: new Date(item.date.value).toISOString(),
            recordedAtSource: recordedAtSource(item.date),
            language: item.language,
          },
          {
            uploadId: entry.uploadId,
            signal: controller.signal,
            onCreated: (uploadId) => {
              entry.uploadId = uploadId
            },
            onProgress: (progress) => setState(id, { kind: 'uploading', progress }),
          },
        )
        runtime.current.delete(id)
        setState(id, { kind: 'done', ...outcome })
        void queryClient.invalidateQueries({ queryKey: ['recordings'] })
      } catch (error) {
        if (entry.canceled) return
        // Upload expired or aborted on the server: the next attempt starts another one.
        if (error instanceof UploadError && error.code === 'upload_gone') entry.uploadId = undefined
        setState(id, { kind: 'error', message: describe(error), resumable: Boolean(entry.uploadId) })
      } finally {
        entry.controller = undefined
      }
    },
    [queryClient, setState],
  )

  /** Processes the ready files, one at a time, until the queue empties. */
  const drain = useCallback(async () => {
    if (running.current) return
    running.current = true
    try {
      for (;;) {
        const next = itemsRef.current.find((item) => item.state.kind === 'ready' && item.date.value)
        if (!next) break
        await process(next.id)
      }
    } finally {
      running.current = false
    }
  }, [process])

  const send = useCallback(() => void drain(), [drain])

  const cancel = useCallback(
    (id: string) => {
      const entry = runtime.current.get(id)
      if (entry) {
        entry.canceled = true
        entry.controller?.abort(new DOMException('Import cancelled.', 'AbortError'))
        if (entry.uploadId) void cancelUpload(entry.uploadId).catch(() => {})
        runtime.current.delete(id)
      }
      setState(id, { kind: 'canceled' })
    },
    [setState],
  )

  const retry = useCallback(
    (id: string) => {
      setState(id, { kind: 'ready' })
      void drain()
    },
    [drain, setState],
  )

  const clearFinished = useCallback(
    () => commit(itemsRef.current.filter((item) => item.state.kind !== 'done' && item.state.kind !== 'canceled')),
    [commit],
  )

  const sending = items.some((item) => BUSY.includes(item.state.kind))
  return { items, sending, add, setDate, edit: update, remove, send, cancel, retry, clearFinished }
}
