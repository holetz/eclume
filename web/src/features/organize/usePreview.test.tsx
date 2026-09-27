import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import { createQueryClient } from '../../app/queryClient'
import { fixtures } from '../../test/fixtures'
import { mockFetch, problem } from '../../test/http'
import { startAgendaTypePreview, startFieldPreview, type Preview } from './queries'
import { agendaPreviewResult, fieldTestRows, PREVIEW_POLL_MS, usePreview } from './usePreview'

const FIELD_DRAFT: Schemas['FieldPreviewRequest'] = { field: { name: 'Cliente', kind: 'text', instructions: 'A empresa' } }

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={createQueryClient({ retry: false })}>{children}</QueryClientProvider>
}

/** Avança o relógio falso e deixa as promessas (fetch, React Query) andarem. */
async function advance(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms))
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** O job passa por `queued`, `running` e termina como a fixture do contrato. */
function mockJob(done: Preview, steps: Preview['status'][] = ['queued', 'running']) {
  let polls = 0
  return mockFetch({
    'POST /api/v1/fields/preview': () => ({ ...done, status: 'queued', items: [] }),
    'POST /api/v1/agenda-types/preview': () => ({ ...done, status: 'queued', items: [] }),
    'GET /api/v1/previews/:id': () => {
      const status = steps[++polls] ?? done.status
      return status === done.status ? done : { ...done, status, items: [] }
    },
  })
}

describe('usePreview', () => {
  it('fica em espera no POST e consulta a cada 1,5 s até o job terminar', async () => {
    const http = mockJob(fixtures.previewFieldRule())
    const { result } = renderHook(() => usePreview(startFieldPreview), { wrapper })
    expect(result.current.state).toBe('idle')

    act(() => result.current.run(FIELD_DRAFT))
    expect(result.current.state).toBe('queued')
    await advance(0)
    expect(await http.requests('POST /api/v1/fields/preview')[0].json()).toEqual(FIELD_DRAFT)
    expect(result.current.state).toBe('queued')
    expect(http.requests('GET /api/v1/previews/:id')).toHaveLength(0)

    await advance(PREVIEW_POLL_MS)
    expect(result.current.state).toBe('running')
    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(1000)

    await advance(PREVIEW_POLL_MS)
    expect(result.current.state).toBe('done')
    expect(result.current.preview?.items).toHaveLength(2)
    const polls = http.requests('GET /api/v1/previews/:id').length

    await advance(PREVIEW_POLL_MS * 4)
    expect(http.requests('GET /api/v1/previews/:id')).toHaveLength(polls)
  })

  it('para no `failed` e expõe o erro do job', async () => {
    const failed: Preview = {
      ...fixtures.previewFieldRule(),
      status: 'failed',
      items: [],
      error: { code: 'no_provider', message: 'Nenhum agente preenche campos.' },
    }
    mockJob(failed, ['queued'])
    const { result } = renderHook(() => usePreview(startFieldPreview), { wrapper })
    act(() => result.current.run(FIELD_DRAFT))
    await advance(0)
    await advance(PREVIEW_POLL_MS)
    expect(result.current.state).toBe('failed')
    expect(result.current.preview?.error?.code).toBe('no_provider')
  })

  it('trata o 404 da consulta como pré-visualização expirada', async () => {
    mockFetch({
      'POST /api/v1/fields/preview': () => ({ ...fixtures.previewFieldRule(), status: 'queued', items: [] }),
      'GET /api/v1/previews/:id': () => problem('not_found', 404),
    })
    const { result } = renderHook(() => usePreview(startFieldPreview), { wrapper })
    act(() => result.current.run(FIELD_DRAFT))
    await advance(0)
    await advance(PREVIEW_POLL_MS)
    expect(result.current.state).toBe('expired')
    expect(result.current.error).toBeNull()
  })

  it('um erro no POST é falha, com o erro da API', async () => {
    mockFetch({ 'POST /api/v1/fields/preview': () => problem('rate_limited', 429) })
    const { result } = renderHook(() => usePreview(startFieldPreview), { wrapper })
    act(() => result.current.run(FIELD_DRAFT))
    await advance(0)
    expect(result.current.state).toBe('failed')
    expect(result.current.error).toMatchObject({ status: 429 })
  })

  it('um run novo descarta o anterior, e a resposta atrasada do antigo é ignorada', async () => {
    const done = fixtures.previewFieldRule()
    let posts = 0
    const http = mockFetch({
      'POST /api/v1/fields/preview': async () => {
        const id = ++posts === 1 ? 'antigo' : 'novo'
        // O primeiro POST demora mais que o segundo.
        if (id === 'antigo') await new Promise((resolve) => setTimeout(resolve, 3000))
        return { ...done, id, status: 'queued', items: [] }
      },
      'GET /api/v1/previews/:id': (_, { id }) => ({ ...done, id }),
    })
    const { result } = renderHook(() => usePreview(startFieldPreview), { wrapper })
    act(() => result.current.run(FIELD_DRAFT))
    await advance(10)
    act(() => result.current.run({ field: { ...FIELD_DRAFT.field, name: 'Projeto' } }))
    await advance(PREVIEW_POLL_MS)
    expect(result.current.state).toBe('done')
    expect(result.current.preview?.id).toBe('novo')

    await advance(3000)
    expect(result.current.preview?.id).toBe('novo')
    const polled = http.requests('GET /api/v1/previews/:id').map((r) => new URL(r.url).pathname.split('/').pop())
    expect(polled).not.toContain('antigo')
  })

  it('reset volta ao estado inicial', async () => {
    mockJob(fixtures.previewAgendaType(), [])
    const { result } = renderHook(() => usePreview(startAgendaTypePreview), { wrapper })
    act(() =>
      result.current.run({
        agenda_type: { name: 'Mentoria', summary_instructions: '## Temas' },
        recording_id: '01928f3a-1c00-7a00-8000-000000000201',
      }),
    )
    await advance(0)
    act(() => result.current.reset())
    expect(result.current.state).toBe('idle')
    expect(result.current.preview).toBeNull()
    expect(result.current.elapsedMs).toBe(0)
  })
})

describe('adaptadores dos resultados', () => {
  it('fieldTestRows dá gravação → valor, com vazio como null e lista unida por vírgula', () => {
    expect(fieldTestRows(fixtures.previewFieldRule())).toEqual([
      { recordingId: '01928f3a-1c00-7a00-8000-000000000201', recordingTitle: 'Revisão do contrato', value: 'Serra Azul' },
      { recordingId: '01928f3a-1c00-7a00-8000-000000000202', recordingTitle: 'Planejamento interno', value: null },
    ])
    const list = fixtures.previewFieldRule()
    list.items = [{ recording_id: 'r', recording_title: 'Planejamento', value: ['interno', 'metas'] }]
    expect(fieldTestRows(list)[0].value).toBe('interno, metas')
    list.items = [{ recording_id: 'r', recording_title: 'Planejamento', value: [] }]
    expect(fieldTestRows(list)[0].value).toBeNull()
    expect(fieldTestRows(fixtures.previewAgendaType())).toEqual([])
  })

  it('agendaPreviewResult dá detecção, título, tags e resumo da gravação', () => {
    expect(agendaPreviewResult(fixtures.previewAgendaType())).toMatchObject({
      detected: true,
      detected_type_name: 'Mentoria',
      confidence: 0.82,
      title: 'Mentoria · Próximos passos na carreira',
      tags: ['mentoria'],
    })
    expect(agendaPreviewResult(fixtures.previewFieldRule())).toBeNull()
  })
})
