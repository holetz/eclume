import { useQuery, type QueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { unwrap } from '../../api/problem'
import { isActive } from '../library/format'
import type { Transcript } from './segments'

const POLL_MS = 3000

export const recordingKey = (id: string) => ['recording', id] as const
export const transcriptKey = (id: string) => ['transcript', id] as const

export function useRecording(id: string) {
  return useQuery({
    queryKey: recordingKey(id),
    queryFn: () =>
      unwrap(api.GET('/api/v1/recordings/{recording_id}', { params: { path: { recording_id: id } } })),
    refetchInterval: (query) => (query.state.data && isActive(query.state.data) ? POLL_MS : false),
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
