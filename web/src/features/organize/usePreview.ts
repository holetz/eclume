// Pré-visualização assíncrona: o POST devolve 202 com o job, e a tela consulta GET /previews/{id}
// até ele terminar. O estado vive 1 h no servidor (Redis): um 404 é uma pré-visualização expirada.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Schemas } from '../../api/client'
import { ApiError, unwrap } from '../../api/problem'
import { pollWhile } from '../../app/polling'
import type { Preview } from './queries'

export const PREVIEW_POLL_MS = 2000

type PreviewState = 'idle' | 'queued' | 'running' | 'done' | 'failed' | 'expired'

export interface PreviewRun<TBody> {
  run(body: TBody): void
  reset(): void
  state: PreviewState
  preview: Preview | null
  elapsedMs: number
  /** O erro da chamada (POST ou consulta); a falha do job vem em `preview.error`. */
  error: unknown
}

const previewKey = (id: string | null) => ['previews', id] as const
const isActive = (status: Preview['status'] | undefined) => status === 'queued' || status === 'running'

export function usePreview<TBody>(start: (body: TBody) => Promise<Preview>): PreviewRun<TBody> {
  const queryClient = useQueryClient()
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // Cada run recebe um número; a resposta de um run anterior chega tarde e é ignorada.
  const runSeq = useRef(0)

  const mutation = useMutation({ mutationFn: start })
  const { mutate, reset: resetMutation } = mutation
  const query = useQuery({
    queryKey: previewKey(previewId),
    queryFn: () =>
      unwrap(api.GET('/api/v1/previews/{preview_id}', { params: { path: { preview_id: previewId! } } })),
    enabled: previewId !== null,
    retry: false,
    refetchInterval: pollWhile((data: Preview | undefined) => isActive(data?.status), PREVIEW_POLL_MS),
  })

  const run = useCallback(
    (body: TBody) => {
      const seq = ++runSeq.current
      setPreviewId(null)
      setStartedAt(Date.now())
      setNow(Date.now())
      resetMutation()
      mutate(body, {
        onSuccess: (preview) => {
          if (seq !== runSeq.current) return
          queryClient.setQueryData(previewKey(preview.id), preview)
          setPreviewId(preview.id)
        },
      })
    },
    [mutate, resetMutation, queryClient],
  )

  const reset = useCallback(() => {
    runSeq.current++
    setPreviewId(null)
    setStartedAt(null)
    resetMutation()
  }, [resetMutation])

  const preview = previewId ? (query.data ?? null) : null
  const expired = query.error instanceof ApiError && query.error.status === 404
  let state: PreviewState
  if (startedAt === null) state = 'idle'
  else if (mutation.isError || (query.isError && !expired)) state = 'failed'
  else if (expired) state = 'expired'
  else if (!preview) state = 'queued'
  else state = preview.status

  const active = state === 'queued' || state === 'running'
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])

  return {
    run,
    reset,
    state,
    preview,
    elapsedMs: startedAt === null ? 0 : Math.max(0, now - startedAt),
    error: mutation.error ?? (expired ? null : query.error),
  }
}

type FieldPreviewItem = Schemas['FieldPreviewItem']
type AgendaTypePreviewItem = Schemas['AgendaTypePreviewItem']

interface FieldTestRow {
  recordingId: string
  recordingTitle: string
  /** O valor em texto (a lista unida por ", "), ou `null` quando a regra deixaria vazio. */
  value: string | null
}

const isFieldItem = (item: Preview['items'][number]): item is FieldPreviewItem => 'value' in item
const isAgendaTypeItem = (item: Preview['items'][number]): item is AgendaTypePreviewItem => 'detected' in item

/** As linhas "gravação → valor" do teste de uma regra de campo. */
export function fieldTestRows(preview: Preview): FieldTestRow[] {
  if (preview.kind !== 'field_rule') return []
  return preview.items.filter(isFieldItem).map((item) => {
    const value = Array.isArray(item.value) ? item.value.join(', ') : item.value
    return { recordingId: item.recording_id, recordingTitle: item.recording_title, value: value || null }
  })
}

/** O resultado da pré-visualização de um tipo de agenda (uma gravação por pedido). */
export function agendaPreviewResult(preview: Preview): AgendaTypePreviewItem | null {
  if (preview.kind !== 'agenda_type') return null
  return preview.items.find(isAgendaTypeItem) ?? null
}
