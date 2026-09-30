// Consultas do diretório de pessoas. Toda chave começa em ['people'], para uma mutação invalidar
// o diretório inteiro de uma vez (contagens e nomes aparecem em várias telas).
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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

/** Cadastra uma pessoa e atualiza o diretório. */
export function useCreatePerson() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['PersonCreate']) => unwrap(api.POST('/api/v1/people', { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PEOPLE_KEY }),
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

/** Até 200 pessoas em ordem alfabética, para escolher numa lista (filtro da busca). */
export function usePeopleOptions() {
  return useQuery({
    queryKey: [...PEOPLE_KEY, 'options'],
    queryFn: () => unwrap(api.GET('/api/v1/people', { params: { query: { limit: 200 } } })),
  })
}

export type VoiceAssignment = Schemas['VoiceAssignment']

const VOICE_ASSIGNMENT_KEY = ['me', 'voice-assignment'] as const

/** A atribuição automática de locutores da conta: liga-desliga e limiar. */
export function useVoiceAssignment() {
  return useQuery({
    queryKey: VOICE_ASSIGNMENT_KEY,
    queryFn: () => unwrap(api.GET('/api/v1/me/voice-assignment')),
  })
}

export function useUpdateVoiceAssignment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['VoiceAssignmentPatch']) => unwrap(api.PATCH('/api/v1/me/voice-assignment', { body })),
    onSuccess: (updated) => queryClient.setQueryData(VOICE_ASSIGNMENT_KEY, updated),
  })
}
