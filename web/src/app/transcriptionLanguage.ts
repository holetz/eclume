import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas } from '../api/client'
import { unwrap } from '../api/problem'
import { languageLabel } from '../lib/languages'

export type TranscriptionPreference = Schemas['TranscriptionPreference']

const KEY = ['me', 'transcription'] as const

/** O idioma de transcrição preferido da conta e o padrão do servidor (`GET /me/transcription`). */
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

/** "Padrão do servidor: Português": o padrão sempre nomeado pelo idioma real. */
export function serverDefaultLabel(preference: TranscriptionPreference): string {
  return `Padrão do servidor: ${languageLabel(preference.platform_default)}`
}

/** O idioma que vale para a conta: o escolhido ou o do servidor. */
export function accountLanguage(preference: TranscriptionPreference): string {
  return preference.language ?? preference.platform_default
}

/** "Padrão da conta: Português": o que vale para um arquivo sem idioma próprio. */
export function accountDefaultLabel(preference: TranscriptionPreference): string {
  return `Padrão da conta: ${languageLabel(accountLanguage(preference))}`
}
