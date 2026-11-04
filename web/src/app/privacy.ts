import { useQuery } from '@tanstack/react-query'
import { api, type Schemas } from '../api/client'
import { unwrap } from '../api/problem'
import { i18n } from '../i18n'

export type DataDestination = Schemas['DataDestination']
export type PrivacyInfo = Schemas['PrivacyInfo']

/**
 * Where each piece of data goes (`GET /privacy`, public). The server classifies; the screens only show it. The
 * configuration changes at runtime: no `staleTime: Infinity`, unlike the server descriptor. The admin
 * panel passes `revision` (the timestamp of the configuration it just read) to re-read after saving.
 */
export function usePrivacy(revision?: string | number) {
  return useQuery({
    queryKey: ['privacy', revision ?? null],
    queryFn: () => unwrap(api.GET('/api/v1/privacy')),
  })
}

type Purpose = DataDestination['purpose']
const PURPOSES: readonly Purpose[] = ['transcription', 'summaries', 'fields', 'chat', 'agenda_detection']

/** The purpose in words, in the active locale: each read goes through the catalog. */
export const PURPOSE_LABEL: Readonly<Record<Purpose, string>> = Object.defineProperties(
  {} as Record<Purpose, string>,
  Object.fromEntries(
    PURPOSES.map((purpose) => [purpose, { enumerable: true, get: () => i18n.t(`shell:privacy.purpose.${purpose}`) }]),
  ),
)

/** The destination in words, in the active locale ("On this server", "Outside the server: Anthropic"…). */
export function locationLabel(destination: DataDestination): string {
  switch (destination.location) {
    case 'server':
    case 'local_network':
    case 'disabled':
      return i18n.t(`shell:privacy.location.${destination.location}`)
    default:
      return destination.processor
        ? i18n.t('shell:privacy.location.externalBy', { processor: destination.processor })
        : i18n.t('shell:privacy.location.external')
  }
}

/** The destinations that send data outside the server and the local network. */
export function externalDestinations(info: PrivacyInfo | undefined): DataDestination[] {
  return info?.destinations.filter((destination) => destination.location === 'external') ?? []
}
