// The question "does the account have any recording?", in a module of its own: the shell asks it on every screen (the
// Agent highlight) without pulling the library queries into the initial JS.
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { unwrap } from '../../api/problem'

/** Whether the account has any recording; `enabled` defers the query until someone needs it. */
export function useHasAnyRecording(enabled = true) {
  return useQuery({
    queryKey: ['recordings', 'any'],
    enabled,
    queryFn: () => unwrap(api.GET('/api/v1/recordings', { params: { query: { limit: 1 } } })),
    select: (page) => page.items.length > 0,
  })
}
