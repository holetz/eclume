// Identificação por voz na página da pessoa: a impressão, remover uma amostra e esquecer a voz.
// As chaves ficam sob ['people', id]: esquecer a voz muda também a pessoa e o diretório.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'
import { PEOPLE_KEY } from './queries'

export type Voiceprint = Schemas['Voiceprint']

export const voiceprintKey = (personId: string) => [...PEOPLE_KEY, personId, 'voiceprint'] as const

export function useVoiceprint(personId: string) {
  return useQuery({
    queryKey: voiceprintKey(personId),
    queryFn: () =>
      unwrap(api.GET('/api/v1/people/{person_id}/voiceprint', { params: { path: { person_id: personId } } })),
  })
}

export function useDeleteVoiceprint(personId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      unwrap(api.DELETE('/api/v1/people/{person_id}/voiceprint', { params: { path: { person_id: personId } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [...PEOPLE_KEY, personId] }),
  })
}

export function useDeleteVoiceSample(personId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sample: { transcript_id: string; speaker_id: string }) =>
      unwrap(
        api.DELETE('/api/v1/people/{person_id}/voice-samples/{transcript_id}/{speaker_id}', {
          params: { path: { person_id: personId, ...sample } },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [...PEOPLE_KEY, personId] }),
  })
}
