import { useQuery } from '@tanstack/react-query'
import { api, type Schemas } from '../api/client'
import { unwrap } from '../api/problem'

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

export const PURPOSE_LABEL: Record<DataDestination['purpose'], string> = {
  transcription: 'Transcrição do áudio',
  summaries: 'Resumos',
  fields: 'Campos',
  chat: 'Chat',
  agenda_detection: 'Detecção do tipo de agenda',
}

/** The destination in words: "Neste servidor", "Na rede local", "Fora do servidor: Anthropic"… */
export function locationLabel(destination: DataDestination): string {
  switch (destination.location) {
    case 'server':
      return 'Neste servidor'
    case 'local_network':
      return 'Na rede local'
    case 'disabled':
      return 'Desligado: nada é enviado'
    default:
      return destination.processor ? `Fora do servidor: ${destination.processor}` : 'Fora do servidor'
  }
}

/** The destinations that send data outside the server and the local network. */
export function externalDestinations(info: PrivacyInfo | undefined): DataDestination[] {
  return info?.destinations.filter((destination) => destination.location === 'external') ?? []
}
