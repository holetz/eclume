// A fila do import: vários arquivos, cada um com o início da gravação lido dos metadados e confirmado
// pela pessoa, convertidos e enviados um por vez. O áudio convertido fica em memória enquanto a
// página está aberta, para retomar o envio que falhou.
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

export type ItemState =
  | { kind: 'reading' }
  | { kind: 'ready' }
  | { kind: 'converting'; ratio: number }
  | { kind: 'uploading'; progress: UploadProgress | null }
  | { kind: 'done'; recordingId: string; deduplicated: boolean }
  | { kind: 'error'; message: string; resumable: boolean }
  | { kind: 'canceled' }

export interface ImportDate {
  /** Valor de `<input type=datetime-local>`, na hora local: `AAAA-MM-DDTHH:MM`. */
  value: string
  /** `metadata` (lida do arquivo), `file_date` (data de modificação) ou `user` (editada). */
  source: 'metadata' | 'file_date' | 'user'
  detail: string
}

export interface ImportItem {
  id: string
  file: File
  probe: MediaProbe | null
  date: ImportDate
  state: ItemState
}

export interface ImportQueue {
  items: ImportItem[]
  /** Há arquivo convertendo ou subindo. */
  sending: boolean
  add: (files: Iterable<File>) => void
  setDate: (id: string, value: string) => void
  remove: (id: string) => void
  send: () => void
  cancel: (id: string) => void
  retry: (id: string) => void
  /** Tira da fila o que já terminou (enviado ou cancelado). */
  clearFinished: () => void
}

interface Runtime {
  converted?: { blob: Blob; sha256: string; durationSec: number }
  uploadId?: string
  controller?: AbortController
  canceled?: boolean
}

/** Nome do arquivo sem a extensão, para o nome do Opus. */
export function fileStem(name: string): string {
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? name.slice(0, dot) : name).trim() || 'gravação'
}

/** `AAAA-MM-DDTHH:MM` na hora local, o formato do `datetime-local`. */
export function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A origem que o upload manda: dos metadados sem edição, ou confirmada pela pessoa. */
export function recordedAtSource(date: ImportDate): 'file_metadata' | 'user' {
  return date.source === 'metadata' ? 'file_metadata' : 'user'
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

  // A fila vive no ref, a fonte da verdade do laço de envio (que não espera o React renderizar); o
  // estado só espelha o ref para a tela.
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
            // Uma data já editada pela pessoa não é trocada pela leitura.
            date:
              current.date.source === 'user'
                ? current.date
                : { value: toLocalInput(read.at), source: read.source, detail: read.detail },
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

  /** Converte (se ainda não) e envia um arquivo; devolve quando termina, falha ou é cancelado. */
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
        // Upload expirado ou abortado no servidor: a próxima tentativa começa outro.
        if (error instanceof UploadError && error.code === 'upload_gone') entry.uploadId = undefined
        setState(id, { kind: 'error', message: describe(error), resumable: Boolean(entry.uploadId) })
      } finally {
        entry.controller = undefined
      }
    },
    [queryClient, setState],
  )

  /** Processa os arquivos prontos, um por vez, até a fila esvaziar. */
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
        entry.controller?.abort(new DOMException('Import cancelado.', 'AbortError'))
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
  return { items, sending, add, setDate, remove, send, cancel, retry, clearFinished }
}
