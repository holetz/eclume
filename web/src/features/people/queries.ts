// Queries of the people directory. Every key starts at ['people'], so that a mutation invalidates
// the whole directory at once (counts and names show up on several screens).
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

/** Registers a person and updates the directory. */
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

/** The person's utterances, in chronological order (`GET /search?person=`). */
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

/** Link that opens the recording at the instant of the utterance. */
export function recordingAt(recordingId: string, ms: number): string {
  return `/gravacoes/${recordingId}?t=${Math.max(0, Math.floor(ms))}`
}

/** Companies, departments and person tags in use: suggestions for the record and the Participantes filter. */
export function usePersonFacets() {
  return useQuery({
    queryKey: [...PEOPLE_KEY, 'facets'],
    queryFn: () => unwrap(api.GET('/api/v1/people/facets')),
  })
}

/** Up to 200 people in alphabetical order, to choose from a list (search filter). */
export function usePeopleOptions() {
  return useQuery({
    queryKey: [...PEOPLE_KEY, 'options'],
    queryFn: () => unwrap(api.GET('/api/v1/people', { params: { query: { limit: 200 } } })),
  })
}

export type VoiceAssignment = Schemas['VoiceAssignment']

const VOICE_ASSIGNMENT_KEY = ['me', 'voice-assignment'] as const

/** The account's automatic speaker assignment: toggle and threshold. */
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

export type SpeakerNaming = Schemas['SpeakerNamingPreference']

/** Key of the required speaker naming; a recording invalidates it when it proceeds without naming. */
export const SPEAKER_NAMING_KEY = ['me', 'speaker-naming'] as const

/** Whether the account requires naming the speakers before the agent chain, and how many recordings are waiting. */
export function useSpeakerNaming() {
  return useQuery({
    queryKey: SPEAKER_NAMING_KEY,
    queryFn: () => unwrap(api.GET('/api/v1/me/speaker-naming')),
  })
}

/** Turns speaker naming on or off; turning it off releases the stopped recordings, so the library is reread. */
export function useUpdateSpeakerNaming() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['SpeakerNamingPatch']) => unwrap(api.PATCH('/api/v1/me/speaker-naming', { body })),
    onSuccess: (updated) => {
      queryClient.setQueryData(SPEAKER_NAMING_KEY, updated)
      void queryClient.invalidateQueries({ queryKey: ['recordings'] })
    },
  })
}
