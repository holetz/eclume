// The recording's markers (from the desktop and the phone): reading, note, deletion and the place of each
// one among the transcript's segments.
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
    // The recording's `marker_count` (and the library's) changes with the deletion.
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
 * For each marker, the index of the first segment that starts at it or later (`start_ms >= at_ms`), or the
 * end of the list when the marker comes after the last segment.
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

/** The current marker at the instant: the last one already passed; none before the first. */
export function currentMarkerId(markers: readonly Marker[], ms: number): string | null {
  let current: string | null = null
  for (const marker of markers) if (marker.at_ms <= ms) current = marker.id
  return current
}

/** The device common to all markers, or `null` when they came from more than one (or from none). */
export function commonDevice(markers: readonly Pick<Marker, 'device_name'>[]): string | null {
  const devices = new Set(markers.map((marker) => marker.device_name))
  const [only] = devices
  return devices.size === 1 && only ? only : null
}
