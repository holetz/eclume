// Identificação por voz na página da pessoa: impressão, consentimento, exclusão e exportação.
// As chaves ficam sob ['people', id]: mudar o consentimento muda também a pessoa e o diretório.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'
import { PEOPLE_KEY } from './queries'

export type Voiceprint = Schemas['Voiceprint']
export type ConsentStatus = Schemas['VoiceConsentPut']['status']

export const voiceprintKey = (personId: string) => [...PEOPLE_KEY, personId, 'voiceprint'] as const

export function useVoiceprint(personId: string) {
  return useQuery({
    queryKey: voiceprintKey(personId),
    queryFn: () =>
      unwrap(api.GET('/api/v1/people/{person_id}/voiceprint', { params: { path: { person_id: personId } } })),
  })
}

function useInvalidatePerson(personId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: [...PEOPLE_KEY, personId] })
}

export function useSetConsent(personId: string) {
  const queryClient = useQueryClient()
  const invalidate = useInvalidatePerson(personId)
  return useMutation({
    mutationFn: (body: { status: ConsentStatus; notes?: string | null }) =>
      unwrap(api.PUT('/api/v1/people/{person_id}/voice-consent', { params: { path: { person_id: personId } }, body })),
    onSuccess: (person) => {
      queryClient.setQueryData([...PEOPLE_KEY, personId], person)
      invalidate()
    },
  })
}

export function useDeleteVoiceprint(personId: string) {
  const invalidate = useInvalidatePerson(personId)
  return useMutation({
    mutationFn: () =>
      unwrap(api.DELETE('/api/v1/people/{person_id}/voiceprint', { params: { path: { person_id: personId } } })),
    onSuccess: invalidate,
  })
}

/** Nome do arquivo da exportação, como o `Content-Disposition` do server. */
export function exportFilename(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `voz-${slug || 'pessoa'}.json`
}

export function useExportVoiceprint(personId: string, name: string) {
  return useMutation({
    mutationFn: () =>
      unwrap(api.GET('/api/v1/people/{person_id}/voiceprint/export', { params: { path: { person_id: personId } } })),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = exportFilename(name)
      anchor.click()
      URL.revokeObjectURL(url)
    },
  })
}
