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
/** Folga do `?since=` sobre a última alteração conhecida, como no observador de desfechos. */
export const SINCE_MARGIN_MS = 60_000
/** A cada tantas leituras incrementais, uma releitura completa pega o que o `?since=` não vê (exclusões). */
export const FULL_EVERY = 20

function anyBusy(items: Recording[] | undefined): boolean {
  return items?.some((item) => recordingState(item).state === 'busy') ?? false
}

/** O `?since=` da leitura incremental: a última alteração conhecida menos a folga; `null` sem nenhuma. */
export function sinceOf(items: Recording[]): string | null {
  const times = items.map((item) => Date.parse(item.updated_at)).filter((at) => !Number.isNaN(at))
  return times.length > 0 ? new Date(Math.max(...times) - SINCE_MARGIN_MS).toISOString() : null
}

/** Troca no cache as gravações que mudaram (por id); `add` diz se as que ainda não estão entram. */
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
 * Enquanto `busy`, mantém a consulta em dia por leituras incrementais (`?since=`) que se mesclam no
 * cache com `setQueryData`, no ritmo de `pollDelay` (3 s de início), em vez de reler o período inteiro.
 * A releitura completa fica para o foco, a volta da rede (o React Query) e a cada `FULL_EVERY`
 * leituras. Pausa com a aba sem foco ou sem rede.
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
          // Falha de rede ou sessão: a próxima volta tenta de novo.
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
  /** Passou do teto de páginas: há mais gravações no período do que as mostradas. */
  truncated: boolean
}

/**
 * As gravações de um período (semana ou grade do mês), por início crescente, seguindo o cursor até o
 * fim ou até o teto. Enquanto alguma está em andamento, lê só o que mudou (`?since=`), no ritmo de
 * `pollDelay` (3 s de início).
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
    // Uma gravação feita no desktop ou no celular aparece ao voltar para a aba.
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
    // Uma gravação feita no desktop ou no celular aparece ao voltar para a aba.
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
    // Só troca o que já está na lista; o que é novo aparece na releitura completa.
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
