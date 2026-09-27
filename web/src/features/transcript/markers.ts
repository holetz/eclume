// Marcadores da gravação (vindos do desktop e do celular): leitura, nota, exclusão e o lugar de cada
// um entre as falas da transcrição.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'
import { markersKey, recordingKey } from './queries'

export type Marker = Schemas['Marker']

/** "00:12:40". */
export function hms(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

export function useMarkers(recordingId: string, enabled = true) {
  return useQuery({
    queryKey: markersKey(recordingId),
    enabled,
    queryFn: () =>
      unwrap(api.GET('/api/v1/recordings/{recording_id}/markers', { params: { path: { recording_id: recordingId } } })),
    select: (page) => [...page.items].sort((a, b) => a.at_ms - b.at_ms),
  })
}

export function useMarkerMutations(recordingId: string) {
  const queryClient = useQueryClient()
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: markersKey(recordingId) })
    // O `marker_count` da gravação (e da biblioteca) muda com a exclusão.
    void queryClient.invalidateQueries({ queryKey: recordingKey(recordingId), exact: true })
    void queryClient.invalidateQueries({ queryKey: ['recordings'] })
  }
  const editNote = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string | null }) =>
      unwrap(api.PATCH('/api/v1/markers/{marker_id}', { params: { path: { marker_id: id } }, body: { note } })),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/api/v1/markers/{marker_id}', { params: { path: { marker_id: id } } })),
    onSuccess: refresh,
  })
  return { editNote, remove }
}

/**
 * Para cada marcador, o índice da primeira fala que começa nele ou depois (`start_ms >= at_ms`), ou o
 * fim da lista quando o marcador vem depois da última fala.
 */
export function placeMarkers(
  segments: readonly { start_ms: number }[],
  markers: readonly Pick<Marker, 'at_ms'>[],
): number[] {
  return markers.map((marker) => {
    const index = segments.findIndex((segment) => segment.start_ms >= marker.at_ms)
    return index === -1 ? segments.length : index
  })
}

/** O marcador corrente no instante: o último já passado; nenhum antes do primeiro. */
export function currentMarkerId(markers: readonly Marker[], ms: number): string | null {
  let current: string | null = null
  for (const marker of markers) if (marker.at_ms <= ms) current = marker.id
  return current
}

/** O dispositivo comum a todos os marcadores, ou `null` quando vieram de mais de um (ou de nenhum). */
export function commonDevice(markers: readonly Pick<Marker, 'device_name'>[]): string | null {
  const devices = new Set(markers.map((marker) => marker.device_name))
  const [only] = devices
  return devices.size === 1 && only ? only : null
}
