import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'
import { recordingState } from '../library/format'
import { stepsDone, type PipelineStep } from './steps'
import type { Transcript } from './segments'

const POLL_MS = 3000

export const recordingKey = (id: string) => ['recording', id] as const
export const transcriptKey = (id: string) => ['transcript', id] as const
export const summaryKey = (id: string) => ['recording', id, 'summary'] as const
export const fieldsKey = (id: string) => ['recording', id, 'fields'] as const
export const markersKey = (id: string) => ['recording', id, 'markers'] as const
export const chatKey = (id: string) => ['recording', id, 'chat'] as const

export function useRecording(id: string) {
  return useQuery({
    queryKey: recordingKey(id),
    queryFn: () =>
      unwrap(api.GET('/api/v1/recordings/{recording_id}', { params: { path: { recording_id: id } } })),
    refetchInterval: (query) => (query.state.data && recordingState(query.state.data).state === 'busy' ? POLL_MS : false),
  })
}

/**
 * Quando o preenchimento, a detecção do tipo ou o resumo terminam no servidor (a etapa passa a
 * `done` numa releitura), relê os campos e o resumo da gravação.
 */
export function useRefreshOnPipeline(recording: Schemas['Recording'] | undefined) {
  const queryClient = useQueryClient()
  const previous = useRef<PipelineStep[] | null>(null)
  useEffect(() => {
    if (!recording) return
    const before = previous.current
    previous.current = recording.pipeline
    if (!before) return
    const done = stepsDone(before, recording.pipeline)
    if (done.some((step) => step === 'fields' || step === 'agenda_type')) {
      void queryClient.invalidateQueries({ queryKey: fieldsKey(recording.id) })
    }
    if (done.some((step) => step === 'agenda_type' || step === 'summary')) {
      void queryClient.invalidateQueries({ queryKey: summaryKey(recording.id) })
    }
  }, [queryClient, recording])
}

/** Exclui a gravação: tira do cache tudo o que é dela e relê a biblioteca. */
export function useDeleteRecording(recording: Pick<Schemas['Recording'], 'id' | 'transcript_id'>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE('/api/v1/recordings/{recording_id}', { params: { path: { recording_id: recording.id } } }),
      ),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: recordingKey(recording.id) })
      if (recording.transcript_id) queryClient.removeQueries({ queryKey: transcriptKey(recording.transcript_id) })
      void queryClient.invalidateQueries({ queryKey: ['recordings'] })
    },
  })
}

export function useTranscript(id: string | null) {
  return useQuery({
    queryKey: transcriptKey(id ?? ''),
    queryFn: () =>
      unwrap(api.GET('/api/v1/transcripts/{transcript_id}', { params: { path: { transcript_id: id! } } })),
    enabled: id !== null,
  })
}

/** Aplica ao cache uma edição que a API já confirmou. */
export function updateTranscriptCache(
  client: QueryClient,
  id: string,
  update: (transcript: Transcript) => Transcript,
): void {
  client.setQueryData<Transcript>(transcriptKey(id), (current) => (current ? update(current) : current))
}
