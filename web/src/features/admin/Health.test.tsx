import { focusManager } from '@tanstack/react-query'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import { fixtures } from '../../test/fixtures'
import { mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'
import { formatDuration } from './labels'

beforeAll(() => preloadRoute('/admin/saude'))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  focusManager.setFocused(undefined)
})

type Health = Schemas['AdminHealth']

function mockHealthApi(health: () => Health | Response = () => fixtures.adminHealth(), extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/admin/me': () => fixtures.adminMe(),
    'GET /api/v1/admin/health': health,
    ...extra,
  })
}

function stat(kicker: string) {
  return screen.getByText(kicker, { selector: '.stat .kicker' }).closest('.stat') as HTMLElement
}

describe('Saúde', () => {
  it('formata a mediana em m:ss', () => {
    expect(formatDuration(6200)).toBe('0:06')
    expect(formatDuration(92_000)).toBe('1:32')
    expect(formatDuration(3_725_000)).toBe('62:05')
  })

  it('mostra os indicadores, as etapas, os serviços e as falhas sem conteúdo de usuário', async () => {
    mockHealthApi()
    renderApp('/admin/saude')
    expect(await screen.findByText('Transcrevendo')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Saúde' })).toBeInTheDocument()
    expect(screen.getByText(/^Atualizado às \d\d:\d\d:\d\d · a cada 15 a 60 s$/)).toHaveAttribute('aria-live', 'polite')

    expect(within(stat('Worker GPU')).getByText('NVIDIA GeForce GTX 1660 SUPER · 6 GB')).toBeInTheDocument()
    expect(within(stat('Modelo residente')).getByText('large-v3-turbo')).toBeInTheDocument()
    expect(within(stat('Modelo residente')).getByText('3,8 / 6 GB de VRAM')).toBeInTheDocument()
    expect(within(stat('Fila')).getByText('2')).toBeInTheDocument()
    expect(within(stat('Fila')).getByText('1 rodando · 1 esperando')).toBeInTheDocument()
    // As falhas de todas as etapas, e a mais recente pela etapa e pelo código.
    expect(within(stat('Falhas · 24 h')).getByText('2')).toBeInTheDocument()
    expect(within(stat('Falhas · 24 h')).getByText('Resumo · provider_unavailable')).toBeInTheDocument()

    const steps = screen.getByRole('region', { name: 'Etapas do processamento · últimas 24 h' })
    const rows = within(steps).getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      'Pré-processamento',
      'Transcrição',
      'Preenchimento de campos',
      'Tipo de agenda',
      'Resumo',
    ])
    expect(rows[1]).toHaveTextContent('141:321 falha')
    expect(within(rows[1]).getByText('1 falha')).toHaveClass('badge-danger')
    expect(within(rows[0]).getByText('0')).toHaveClass('text-muted')

    const services = screen.getByRole('region', { name: 'Serviços' })
    expect(within(services).getByRole('row', { name: /Servidor da API/ })).toHaveTextContent('Saudável0.1.0 · 0 ms')
    expect(within(services).getByRole('row', { name: /Postgres \+ pgvector/ })).toHaveTextContent('RLS ativa · 4 ms')
    const mcp = within(services).getByRole('row', { name: /Servidor MCP/ })
    expect(within(mcp).getByText('Ausente')).toHaveClass('badge')
    expect(within(mcp).getByText('Ausente')).not.toHaveClass('badge-success')

    const failures = screen.getByRole('region', { name: 'Falhas recentes' })
    const failure = within(failures).getByRole('row', { name: /provider_unavailable/ })
    expect(failure).toHaveTextContent('Resumo')
    // Resumo não tem job para retentar, e o admin não abre a gravação.
    expect(within(failure).queryByRole('button')).not.toBeInTheDocument()
    expect(within(failures).queryByRole('link')).not.toBeInTheDocument()
    // Saíram as filas e os jobs em andamento, que traziam o título da gravação.
    expect(screen.queryByText(/Reunião de alinhamento/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Transcrição \(GPU\)/)).not.toBeInTheDocument()
  })

  it('sem worker, sem GPU e com etapas faltando; retenta a transcrição', async () => {
    const health = fixtures.adminHealth()
    health.worker = null
    health.gpu = null
    health.models_loaded = []
    health.steps = [{ step: 'transcription', runs: 3, median_ms: null, failures: 2 }]
    health.services.push({ name: 'fila_nova' as Health['services'][number]['name'], status: 'down', detail: null, latency_ms: null })
    health.recent_failures = [
      {
        job_id: '01928f3a-1c00-7a00-8000-000000000e09',
        recording_id: '01928f3a-1c00-7a00-8000-000000000309',
        step: 'transcription',
        stage: 'asr',
        code: 'out_of_memory',
        message: 'VRAM insuficiente',
        failed_at: '2026-09-19T12:00:00Z',
        retryable: true,
      },
    ]
    const http = mockHealthApi(() => health, {
      'POST /api/v1/admin/jobs/:id/retry': () => ({
        job_id: '01928f3a-1c00-7a00-8000-000000000e10',
        recording_id: '01928f3a-1c00-7a00-8000-000000000309',
        revision: 2,
        state: 'queued',
        queued_at: '2026-09-19T12:05:00Z',
      }),
    })
    renderApp('/admin/saude')
    expect(await screen.findByText('Sem sinal')).toBeInTheDocument()
    expect(within(stat('Worker GPU')).getByText('Sem leitura da GPU')).toBeInTheDocument()
    expect(within(stat('Modelo residente')).getByText('Nenhum')).toBeInTheDocument()
    expect(within(stat('Modelo residente')).getByText('Sai da GPU depois de alguns minutos sem job')).toBeInTheDocument()
    expect(within(stat('Falhas · 24 h')).getByText('Transcrição · out_of_memory')).toBeInTheDocument()

    const steps = screen.getByRole('region', { name: 'Etapas do processamento · últimas 24 h' })
    expect(within(steps).getAllByRole('row')).toHaveLength(6)
    expect(within(steps).getByRole('row', { name: /Transcrição/ })).toHaveTextContent('3—2 falhas')
    expect(within(steps).getByRole('row', { name: /Resumo/ })).toHaveTextContent('0—0')
    const services = screen.getByRole('region', { name: 'Serviços' })
    expect(within(services).getByRole('row', { name: /fila_nova/ })).toHaveTextContent('Fora')

    const failure = screen.getByRole('row', { name: /out_of_memory/ })
    const retry = within(failure).getByRole('button', { name: 'Tentar de novo' })
    expect(retry).toHaveClass('btn-primary')
    await userEvent.click(retry)
    expect(await within(failure).findByText('Na fila de novo.')).toBeInTheDocument()
    expect(new URL(http.requests('POST /api/v1/admin/jobs/:id/retry')[0].url).pathname).toBe(
      '/api/v1/admin/jobs/01928f3a-1c00-7a00-8000-000000000e09/retry',
    )
  })

  it('relê a cada 15 s só com a aba visível e mantém os dados num erro', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let fail = false
    const http = mockHealthApi(() => (fail ? problem('internal', 500) : fixtures.adminHealth()))
    renderApp('/admin/saude')
    expect(await screen.findByText('Transcrevendo')).toBeInTheDocument()
    const reads = () => http.requests('GET /api/v1/admin/health').length
    expect(reads()).toBe(1)

    await act(() => vi.advanceTimersByTimeAsync(14_000))
    expect(reads()).toBe(1)
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    expect(reads()).toBe(2)

    // Aba escondida: sem releitura.
    act(() => focusManager.setFocused(false))
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(reads()).toBe(2)
    act(() => focusManager.setFocused(true))

    fail = true
    await act(() => vi.advanceTimersByTimeAsync(15_000))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Transcrevendo')).toBeInTheDocument()
  })

  it('sem mudança, o intervalo dobra de 15 s até 60 s; uma mudança volta aos 15 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let queued = 0
    const http = mockHealthApi(() => {
      const health = fixtures.adminHealth()
      health.queue.queued = queued
      return health
    })
    renderApp('/admin/saude')
    expect(await screen.findByText('Transcrevendo')).toBeInTheDocument()
    const reads = () => http.requests('GET /api/v1/admin/health').length
    const after = async (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

    await after(15_000)
    expect(reads()).toBe(2)
    await after(29_000)
    expect(reads()).toBe(2)
    await after(1_000)
    expect(reads()).toBe(3)
    await after(59_000)
    expect(reads()).toBe(3)
    await after(1_000)
    expect(reads()).toBe(4)
    await after(60_000)
    expect(reads()).toBe(5)

    // A fila mudou: a leitura seguinte já volta ao ritmo inicial.
    queued = 7
    await after(60_000)
    expect(reads()).toBe(6)
    await after(15_000)
    expect(reads()).toBe(7)
  })
})
