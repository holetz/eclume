import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'
import { pollWhile } from '../../app/polling'
import type { Range } from './calendar'
import { filtersToQuery, type LibraryFilters } from './filters'
import { recordingState } from './format'

type Recording = Schemas['Recording']

const POLL_MS = 3000
const RANGE_LIMIT = 200
export const RANGE_MAX_PAGES = 5
const LIST_LIMIT = 50

function anyBusy(items: Recording[] | undefined): boolean {
  return items?.some((item) => recordingState(item).state === 'busy') ?? false
}

interface RangeResult {
  items: Recording[]
  /** Passou do teto de páginas: há mais gravações no período do que as mostradas. */
  truncated: boolean
}

/**
 * As gravações de um período (semana ou grade do mês), por início crescente, seguindo o cursor até o
 * fim ou até o teto. Enquanto alguma está em andamento, relê no ritmo de `pollWhile` (3 s de início).
 */
export function useLibraryRange(range: Range, filters: LibraryFilters, enabled = true) {
  const from = range.from.toISOString()
  const to = range.to.toISOString()
  return useQuery({
    queryKey: ['recordings', 'range', { from, to, filters }],
    enabled,
    queryFn: async (): Promise<RangeResult> => {
      const items: Recording[] = []
      let cursor: string | null = null
      for (let page = 0; page < RANGE_MAX_PAGES; page++) {
        const result: Schemas['RecordingPage'] = await unwrap(
          api.GET('/api/v1/recordings', {
            params: {
              query: {
                from,
                to,
                sort: 'recorded_asc',
                limit: RANGE_LIMIT,
                ...filtersToQuery(filters),
                ...(cursor ? { cursor } : {}),
              },
            },
          }),
        )
        items.push(...result.items)
        cursor = result.next_cursor
        if (!cursor) return { items, truncated: false }
      }
      return { items, truncated: true }
    },
    refetchInterval: pollWhile<RangeResult>((data) => anyBusy(data?.items), POLL_MS),
  })
}

/** Os campos do usuário (embutidos e próprios), para os filtros e o painel de campos. */
export function useUserFields() {
  return useQuery({
    queryKey: ['fields'],
    queryFn: () => unwrap(api.GET('/api/v1/fields')),
    staleTime: 60_000,
  })
}

/** A lista corrida, da mais recente para a mais antiga, com "Carregar mais". */
export function useLibraryList(filters: LibraryFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['recordings', 'list', filters],
    enabled,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/recordings', {
          params: {
            query: {
              sort: 'recorded_desc',
              limit: LIST_LIMIT,
              ...filtersToQuery(filters),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    refetchInterval: pollWhile<{ pages: { items: Recording[] }[] }>(
      (data) => data?.pages.some((page) => anyBusy(page.items)) ?? false,
      POLL_MS,
    ),
  })
}
