import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'
import { pollWhile } from '../../app/polling'

import { stepsDone, type PipelineStep } from './steps'
import type { Transcript } from './segments'
import { recordingState } from '../../shared/format'

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
    refetchOnWindowFocus: true,
    // Also re-reads while the recording waits for the speakers' names: someone may name them from another
    // device or release the recording, and the chain carries on by itself on the server.
    refetchInterval: pollWhile((data: Schemas['Recording'] | undefined) => {
      const state = data ? recordingState(data).state : null
      return state === 'busy' || state === 'waiting'
    }, POLL_MS),
  })
}

/** "Seguir sem nomear": releases the recording stopped waiting for the speakers' names. */
export function useContinueWithoutNames(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      unwrap(api.POST('/api/v1/recordings/{recording_id}/continue', { params: { path: { recording_id: id } } })),
    onSuccess: (updated) => {
      queryClient.setQueryData(recordingKey(id), updated)
      void queryClient.invalidateQueries({ queryKey: ['recordings'] })
      void queryClient.invalidateQueries({ queryKey: ['me', 'speaker-naming'] })
    },
  })
}

/**
 * When the filling, the type detection or the summary finishes on the server (the step moves to
 * `done` on a re-read), re-reads the recording's fields and summary.
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

/** Cancels the transcription in progress or in the queue; the recording comes back as the server left it (`failed`). */
export function useCancelTranscription(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      unwrap(api.POST('/api/v1/recordings/{recording_id}/cancel', { params: { path: { recording_id: id } } })),
    onSuccess: (updated) => {
      queryClient.setQueryData(recordingKey(id), updated)
      void queryClient.invalidateQueries({ queryKey: ['recordings'] })
    },
  })
}

/** Deletes the recording: removes from the cache everything that belongs to it and re-reads the library. */
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

/** Applies to the cache an edit the API has already confirmed. */
export function updateTranscriptCache(
  client: QueryClient,
  id: string,
  update: (transcript: Transcript) => Transcript,
): void {
  client.setQueryData<Transcript>(transcriptKey(id), (current) => (current ? update(current) : current))
}
