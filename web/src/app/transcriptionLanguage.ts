import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas } from '../api/client'
import { unwrap } from '../api/problem'
import { i18n } from '../i18n'
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

/** "Server default: Portuguese": the default always named by the real language. */
export function serverDefaultLabel(preference: TranscriptionPreference): string {
  return i18n.t('shell:transcription.serverDefault', { language: languageLabel(preference.platform_default) })
}

/** The language that holds for the account: the chosen one or the server's. */
export function accountLanguage(preference: TranscriptionPreference): string {
  return preference.language ?? preference.platform_default
}

/** "Account default: Portuguese": what holds for a file without its own language. */
export function accountDefaultLabel(preference: TranscriptionPreference): string {
  return i18n.t('shell:transcription.accountDefault', { language: languageLabel(accountLanguage(preference)) })
}
