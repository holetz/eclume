// Consultas do diretório de pessoas. Toda chave começa em ['people'], para uma mutação invalidar
// o diretório inteiro de uma vez (contagens e nomes aparecem em várias telas).
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'

export type Person = Schemas['Person']

export const PEOPLE_KEY = ['people'] as const
const PAGE = 25

export function usePeople(q: string) {
  return useInfiniteQuery({
    queryKey: [...PEOPLE_KEY, 'list', q],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/people', {
          params: { query: { limit: PAGE, ...(q ? { q } : {}), ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  })
}

export function usePerson(id: string) {
  return useQuery({
    queryKey: [...PEOPLE_KEY, id],
    queryFn: () => unwrap(api.GET('/api/v1/people/{person_id}', { params: { path: { person_id: id } } })),
  })
}

export function usePersonTranscripts(id: string) {
  return useInfiniteQuery({
    queryKey: [...PEOPLE_KEY, id, 'transcripts'],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/people/{person_id}/transcripts', {
          params: { path: { person_id: id }, query: { limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  })
}

/** As falas da pessoa, em ordem cronológica (`GET /search?person=`). */
export function usePersonSegments(id: string) {
  return useInfiniteQuery({
    queryKey: [...PEOPLE_KEY, id, 'segments'],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/search', {
          params: { query: { person: id, limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  })
}

/** Link que abre a gravação no instante da fala. */
export function recordingAt(recordingId: string, ms: number): string {
  return `/gravacoes/${recordingId}?t=${Math.max(0, Math.floor(ms))}`
}
