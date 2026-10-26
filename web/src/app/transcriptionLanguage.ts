import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas } from '../api/client'
import { unwrap } from '../api/problem'
import { languageLabel } from '../lib/languages'

export type TranscriptionPreference = Schemas['TranscriptionPreference']

const KEY = ['me', 'transcription'] as const

/** The account's preferred transcription language and the server default (`GET /me/transcription`). */
export function useTranscriptionPreference() {
  return useQuery({ queryKey: KEY, queryFn: () => unwrap(api.GET('/api/v1/me/transcription')) })
}

export function useUpdateTranscriptionPreference() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (language: string | null) =>
      unwrap(api.PATCH('/api/v1/me/transcription', { body: { language } })),
    onSuccess: (updated) => queryClient.setQueryData(KEY, updated),
  })
}

/** "Padrão do servidor: Português": the default always named by the real language. */
export function serverDefaultLabel(preference: TranscriptionPreference): string {
  return `Padrão do servidor: ${languageLabel(preference.platform_default)}`
}

/** The language that holds for the account: the chosen one or the server's. */
export function accountLanguage(preference: TranscriptionPreference): string {
  return preference.language ?? preference.platform_default
}

/** "Padrão da conta: Português": what holds for a file without its own language. */
export function accountDefaultLabel(preference: TranscriptionPreference): string {
  return `Padrão da conta: ${languageLabel(accountLanguage(preference))}`
}
