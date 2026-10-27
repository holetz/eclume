// The user's tag registry and how the agent assigns them. Few per user (the registry cap is
// 200): the whole list fits in a single response.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'

export type Tag = Schemas['Tag']
export type TagAssignment = Schemas['TagAssignment']

export const TAGS_KEY = ['tags'] as const
const TAG_ASSIGNMENT_KEY = ['me', 'tag-assignment'] as const

/** The registry, in alphabetical order; the library and search filter also reads from here. */
export function useTags() {
  return useQuery({ queryKey: TAGS_KEY, queryFn: () => unwrap(api.GET('/api/v1/tags')) })
}

/** The agent configuration: automatic, general rule, mode and limit, with the registry size. */
export function useTagAssignment() {
  return useQuery({
    queryKey: TAG_ASSIGNMENT_KEY,
    queryFn: () => unwrap(api.GET('/api/v1/me/tag-assignment')),
  })
}

export function useUpdateTagAssignment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['TagAssignmentPatch']) => unwrap(api.PATCH('/api/v1/me/tag-assignment', { body })),
    onSuccess: (updated) => queryClient.setQueryData(TAG_ASSIGNMENT_KEY, updated),
  })
}

/**
 * Updates what changes with the registry: the list, its size (shown on the card) and the agenda
 * types, which carry default tags. Renaming, merging and deleting also touch the recordings, open or
 * in the lists.
 */
export function useRefreshTags() {
  const queryClient = useQueryClient()
  return (recordings: boolean) => {
    void queryClient.invalidateQueries({ queryKey: TAGS_KEY })
    void queryClient.invalidateQueries({ queryKey: TAG_ASSIGNMENT_KEY })
    void queryClient.invalidateQueries({ queryKey: ['agenda-types'] })
    if (recordings) {
      void queryClient.invalidateQueries({ queryKey: ['recordings'] })
      void queryClient.invalidateQueries({ queryKey: ['recording'] })
    }
  }
}
