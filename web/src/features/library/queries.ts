import { focusManager, onlineManager, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'
import { pollDelay } from '../../app/polling'
import type { Range } from './calendar'
import { filtersToQuery, type LibraryFilters } from './filters'
import { recordingState } from '../../shared/format'
import { PEOPLE_KEY } from '../people/queries'

type Recording = Schemas['Recording']

const POLL_MS = 3000
const RANGE_LIMIT = 200
export const RANGE_MAX_PAGES = 5
const LIST_LIMIT = 50
/** Slack of `?since=` over the last known change, as in the outcome watcher. */
export const SINCE_MARGIN_MS = 60_000
/** Every so many incremental reads, a full re-read catches what `?since=` does not see (deletions). */
export const FULL_EVERY = 20

function anyBusy(items: Recording[] | undefined): boolean {
  return items?.some((item) => recordingState(item).state === 'busy') ?? false
}

/** The `?since=` of the incremental read: the last known change minus the slack; `null` with none. */
export function sinceOf(items: Recording[]): string | null {
  const times = items.map((item) => Date.parse(item.updated_at)).filter((at) => !Number.isNaN(at))
  return times.length > 0 ? new Date(Math.max(...times) - SINCE_MARGIN_MS).toISOString() : null
}

/** Replaces in the cache the recordings that changed (by id); `add` says whether the ones not there yet go in. */
export function mergeChanged(items: Recording[], changed: Recording[], add: boolean): Recording[] {
  const byId = new Map(changed.map((item) => [item.id, item]))
  const merged = items.map((item) => byId.get(item.id) ?? item)
  if (add) {
    const known = new Set(items.map((item) => item.id))
    merged.push(...changed.filter((item) => !known.has(item.id)))
  }
  return merged
}

/**
 * While `busy`, keeps the query up to date through incremental reads (`?since=`) that merge into the
 * cache with `setQueryData`, at the `pollDelay` pace (3 s at first), instead of re-reading the whole period.
 * The full re-read is left to focus, the network coming back (React Query) and every `FULL_EVERY`
 * reads. It pauses with the tab unfocused or offline.
 */
function useDeltaRefresh<T>(options: {
  queryKey: readonly unknown[]
  busy: boolean
  items: (data: T) => Recording[]
  read: (since: string) => Promise<Recording[]>
  merge: (data: T, changed: Recording[]) => T
}) {
  const queryClient = useQueryClient()
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })
  const { busy } = options
  const hash = JSON.stringify(options.queryKey)

  useEffect(() => {
    if (!busy) return
    const queryKey = latest.current.queryKey
    let stopped = false
    let timer: number | undefined
    let startedAt = Date.now()
    let reads = 0
    const restart = () => {
      startedAt = Date.now()
      reads = 0
    }
    const unsubscribe = [
      focusManager.subscribe((focused) => focused && restart()),
      onlineManager.subscribe((online) => online && restart()),
    ]

    const refresh = async () => {
      const { items, read, merge } = latest.current
      const data = queryClient.getQueryData<T>(queryKey)
      const since = data === undefined ? null : sinceOf(items(data))
      if (since === null || reads >= FULL_EVERY) {
        reads = 0
        await queryClient.invalidateQueries({ queryKey, exact: true })
        return
      }
      reads += 1
      const changed = await read(since)
      if (stopped || changed.length === 0) return
      queryClient.setQueryData<T>(queryKey, (current) => (current === undefined ? current : merge(current, changed)))
    }

    const schedule = () => {
      timer = window.setTimeout(() => void run(), pollDelay(POLL_MS, Date.now() - startedAt))
    }
    const run = async () => {
      if (focusManager.isFocused() && onlineManager.isOnline()) {
        try {
          await refresh()
        } catch {
          // Network or session failure: the next round tries again.
        }
      }
      if (!stopped) schedule()
    }
    schedule()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      unsubscribe.forEach((off) => off())
    }
  }, [busy, hash, queryClient])
}

interface RangeResult {
  items: Recording[]
  /** Past the page ceiling: there are more recordings in the period than those shown. */
  truncated: boolean
}

/**
 * The recordings of a period (week or month grid), by ascending start, following the cursor to the
 * end or to the ceiling. While any is in progress, it reads only what changed (`?since=`), at the
 * `pollDelay` pace (3 s at first).
 */
export function useLibraryRange(range: Range, filters: LibraryFilters, enabled = true) {
  const from = range.from.toISOString()
  const to = range.to.toISOString()
  const queryKey = ['recordings', 'range', { from, to, filters }]
  const readPages = async (since?: string): Promise<RangeResult> => {
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
              ...(since ? { since } : {}),
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
  }
  const query = useQuery({
    queryKey,
    enabled,
    queryFn: () => readPages(),
    // A recording made on the desktop or the phone shows up when returning to the tab.
    refetchOnWindowFocus: true,
  })
  useDeltaRefresh<RangeResult>({
    queryKey,
    busy: enabled && anyBusy(query.data?.items),
    items: (data) => data.items,
    read: async (since) => (await readPages(since)).items,
    merge: (data, changed) => ({
      ...data,
      items: mergeChanged(data.items, changed, true).sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at)),
    }),
  })
  return query
}

/** The user's fields (built-in and own), for the filters and the fields panel. */
export function useUserFields() {
  return useQuery({
    queryKey: ['fields'],
    queryFn: () => unwrap(api.GET('/api/v1/fields')),
    staleTime: 60_000,
  })
}

/** The running list, from newest to oldest, with "Carregar mais". */
export function useLibraryList(filters: LibraryFilters, enabled = true) {
  const queryKey = ['recordings', 'list', filters]
  const query = useInfiniteQuery({
    queryKey,
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
    // A recording made on the desktop or the phone shows up when returning to the tab.
    refetchOnWindowFocus: true,
  })
  type Pages = { pages: Schemas['RecordingPage'][]; pageParams: unknown[] }
  useDeltaRefresh<Pages>({
    queryKey,
    busy: enabled && (query.data?.pages.some((page) => anyBusy(page.items)) ?? false),
    items: (data) => data.pages.flatMap((page) => page.items),
    read: async (since) => {
      const items: Recording[] = []
      let cursor: string | null = null
      do {
        const page: Schemas['RecordingPage'] = await unwrap(
          api.GET('/api/v1/recordings', {
            params: {
              query: {
                sort: 'recorded_desc',
                limit: RANGE_LIMIT,
                ...filtersToQuery(filters),
                since,
                ...(cursor ? { cursor } : {}),
              },
            },
          }),
        )
        items.push(...page.items)
        cursor = page.next_cursor
      } while (cursor)
      return items
    },
    // Replaces only what is already in the list; what is new shows up in the full re-read.
    merge: (data, changed) => ({
      ...data,
      pages: data.pages.map((page) => ({ ...page, items: mergeChanged(page.items, changed, false) })),
    }),
  })
  return query
}

export function useHasAnyPerson(enabled: boolean) {
  return useQuery({
    queryKey: [...PEOPLE_KEY, 'any'],
    enabled,
    queryFn: () => unwrap(api.GET('/api/v1/people', { params: { query: { limit: 1 } } })),
    select: (page) => page.items.length > 0,
  })
}
