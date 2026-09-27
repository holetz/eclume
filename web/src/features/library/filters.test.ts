import { renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../app/queryClient'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
import { weekRange } from './calendar'
import {
  activeFilterCount,
  filtersToQuery,
  NO_FILTERS,
  readFilters,
  readView,
  rememberedSearch,
  writeFilters,
} from './filters'
import { RANGE_MAX_PAGES, useLibraryList, useLibraryRange } from './queries'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('filtros na URL', () => {
  it('lê os filtros em pt-BR, repetíveis, e descarta valores estranhos', () => {
    const params = new URLSearchParams(
      'visao=semana&data=2026-09-21&tipo=nota&tipo=xyz&situacao=falhou&situacao=pronta&tag=backlog&tag=backlog' +
        '&pessoa=p1&colecao=c1&campo=f1:Serra%20Azul&campo=sem-valor',
    )
    expect(readFilters(params)).toEqual({
      kind: ['nota'],
      status: ['falhou', 'pronta'],
      tag: ['backlog'],
      person: ['p1'],
      collection: ['c1'],
      field: ['f1:Serra Azul'],
    })
    expect(readView(params)).toBe('semana')
    expect(readView(new URLSearchParams('visao=ano'))).toBeNull()
    expect(activeFilterCount(readFilters(params))).toBe(7)
  })

  it('escreve os filtros sem mexer na visão, na data nem no modal', () => {
    const params = new URLSearchParams('visao=mes&data=2026-09-21&importar=1&tag=antiga')
    const next = writeFilters(params, { ...NO_FILTERS, kind: ['reuniao'], field: ['f1:a', 'f1:b'] })
    expect(next.toString()).toBe('visao=mes&data=2026-09-21&importar=1&tipo=reuniao&campo=f1%3Aa&campo=f1%3Ab')
    expect(rememberedSearch(next)).toBe('visao=mes&data=2026-09-21&tipo=reuniao&campo=f1%3Aa&campo=f1%3Ab')
  })

  it('traduz para a query de GET /recordings pelo enum do contrato', () => {
    expect(filtersToQuery(NO_FILTERS)).toEqual({})
    expect(
      filtersToQuery({
        kind: ['nota'],
        status: ['processando', 'falhou'],
        tag: ['a'],
        person: ['p1'],
        collection: ['c1'],
        field: ['f1:x'],
      }),
    ).toEqual({
      kind: ['note'],
      status: ['uploading', 'queued', 'processing', 'failed'],
      tag: ['a'],
      person: ['p1'],
      collection: ['c1'],
      field: ['f1:x'],
    })
    // Tudo marcado num grupo não manda o parâmetro.
    expect(
      filtersToQuery({ ...NO_FILTERS, kind: ['reuniao', 'nota'], status: ['pronta', 'processando', 'falhou'] }),
    ).toEqual({})
  })
})

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: createQueryClient({ retry: false }) }, children)
}

describe('consultas da biblioteca', () => {
  const week = weekRange(new Date(2026, 8, 24))

  it('pede o período em ordem de início, segue o cursor e para no teto', async () => {
    let calls = 0
    const http = mockFetch({
      'GET /api/v1/recordings': () => {
        calls++
        const page = fixtures.recordingWeekPage()
        return { items: page.items.slice(0, 2), next_cursor: `c${calls}` }
      },
    })
    const { result } = renderHook(() => useLibraryRange(week, { ...NO_FILTERS, tag: ['backlog'] }), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.items).toHaveLength(2 * RANGE_MAX_PAGES)
    expect(result.current.data?.truncated).toBe(true)

    const requests = http.requests('GET /api/v1/recordings').map((r) => new URL(r.url).searchParams)
    expect(requests).toHaveLength(RANGE_MAX_PAGES)
    expect(requests[0].get('from')).toBe('2026-09-21T03:00:00.000Z')
    expect(requests[0].get('to')).toBe('2026-09-28T03:00:00.000Z')
    expect(requests[0].get('sort')).toBe('recorded_asc')
    expect(requests[0].get('limit')).toBe('200')
    expect(requests[0].getAll('tag')).toEqual(['backlog'])
    expect(requests[0].get('cursor')).toBeNull()
    expect(requests[1].get('cursor')).toBe('c1')
  })

  it('termina no fim do cursor e relê enquanto algo está em andamento', async () => {
    const page = fixtures.recordingWeekPage()
    let calls = 0
    mockFetch({
      'GET /api/v1/recordings': () => {
        calls++
        if (calls > 1) {
          const summarizing = page.items.find((item) => item.pipeline.some((step) => step.state === 'active'))!
          summarizing.pipeline = summarizing.pipeline.map((step) => ({ ...step, state: 'done' }))
        }
        return page
      },
    })
    const { result } = renderHook(() => useLibraryRange(week, NO_FILTERS), { wrapper })
    await waitFor(() => expect(result.current.data?.truncated).toBe(false))
    expect(result.current.data?.items).toHaveLength(10)
    await waitFor(() => expect(calls).toBe(2), { timeout: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 3500))
    expect(calls).toBe(2)
  }, 12_000)

  it('a lista pede da mais recente para a mais antiga, 50 por página', async () => {
    const http = mockFetch({
      'GET /api/v1/recordings': () => ({ items: [fixtures.recordingTranscribed()], next_cursor: null }),
    })
    const { result } = renderHook(() => useLibraryList({ ...NO_FILTERS, kind: ['nota'] }), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const query = new URL(http.requests('GET /api/v1/recordings')[0].url).searchParams
    expect(query.get('sort')).toBe('recorded_desc')
    expect(query.get('limit')).toBe('50')
    expect(query.getAll('kind')).toEqual(['note'])
  })
})
