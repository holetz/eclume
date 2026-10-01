import { useQuery } from '@tanstack/react-query'
import { api, type Schemas } from '../api/client'
import { unwrap } from '../api/problem'

export type DataDestination = Schemas['DataDestination']
export type PrivacyInfo = Schemas['PrivacyInfo']

/**
 * Para onde vai cada dado (`GET /privacy`, pública). O servidor classifica; as telas só mostram. A
 * configuração muda em runtime: sem `staleTime: Infinity`, ao contrário do descritor do servidor.
 */
export function usePrivacy() {
  return useQuery({
    queryKey: ['privacy'],
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

/** O destino em palavras: "Neste servidor", "Na rede local", "Fora do servidor: Anthropic"… */
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

/** Os destinos que mandam dados para fora do servidor e da rede local. */
export function externalDestinations(info: PrivacyInfo | undefined): DataDestination[] {
  return info?.destinations.filter((destination) => destination.location === 'external') ?? []
}
