import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'
import { formatBytes, formatDuration, isActive, statusInfo } from './format'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('formatos', () => {
  it('formata duração, tamanho e estados, tolerando enum novo', () => {
    expect(formatDuration(45_000)).toBe('45 s')
    expect(formatDuration(166_000)).toBe('2 min 46 s')
    expect(formatDuration(120_000)).toBe('2 min')
    expect(formatDuration(3_900_000)).toBe('1 h 05 min')
    expect(formatDuration(null)).toBe('—')
    expect(formatBytes(11_604_992)).toBe('11,1 MB')
    expect(statusInfo('transcribed')).toEqual({ label: 'Transcrita', tone: 'success' })
    expect(statusInfo('archived')).toEqual({ label: 'archived', tone: 'neutral' })
    expect(isActive({ status: 'processing' })).toBe(true)
    expect(isActive({ status: 'transcribed' })).toBe(false)
  })
})

describe('biblioteca', () => {
  it('lista as gravações com estado, etapa e progresso do job', async () => {
    mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/recordings': () => fixtures.recordingPage(),
    })
    renderApp('/')
    const list = await screen.findByRole('list', { name: 'Gravações' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)

    const processing = rows[0]
    expect(within(processing).getByRole('link', { name: 'Entrevista inicial — gestor de produção' })).toHaveAttribute(
      'href',
      '/gravacoes/01928f3a-1c00-7a00-8000-000000000402',
    )
    expect(within(processing).getByText('Transcrevendo')).toBeInTheDocument()
    expect(within(processing).getByText('Separando locutores')).toBeInTheDocument()
    expect(within(processing).getByRole('progressbar')).toHaveAttribute('value', '62')

    const done = rows[1]
    expect(within(done).getByText('Transcrita')).toBeInTheDocument()
    expect(within(done).getByText('2 min 46 s')).toBeInTheDocument()
    expect(within(done).getByText('App desktop')).toBeInTheDocument()
    expect(within(done).queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('atualiza sozinha enquanto há job ativo e para quando todos terminam', async () => {
    const page = fixtures.recordingPage()
    let calls = 0
    mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/recordings': () => {
        calls++
        if (calls > 1) {
          page.items[0].status = 'transcribed'
          page.items[0].job!.state = 'succeeded'
        }
        return page
      },
    })
    renderApp('/')
    await screen.findByText('Transcrevendo')
    await waitFor(() => expect(screen.getAllByText('Transcrita')).toHaveLength(2), { timeout: 5000 })
    const settled = calls
    await new Promise((resolve) => setTimeout(resolve, 3500))
    expect(calls).toBe(settled)
  }, 12_000)

  it('mostra o erro do job que falhou', async () => {
    const page = fixtures.recordingPage()
    page.items[0].status = 'failed'
    page.items[0].job = { ...page.items[0].job!, state: 'failed', error: { code: 'gpu_oom', message: 'Memória da GPU esgotada.' } }
    mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/recordings': () => page,
    })
    renderApp('/')
    expect(await screen.findByText('Falhou')).toBeInTheDocument()
    expect(screen.getByText(/Memória da GPU esgotada\./)).toBeInTheDocument()
  })

  it('filtra por dono e pagina por cursor', async () => {
    const first = fixtures.recordingPage()
    first.next_cursor = 'c2'
    const second = { items: [{ ...fixtures.recordingTranscribed(), id: 'rec-3', title: 'Terceira gravação' }], next_cursor: null }
    const http = mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/recordings': (request) =>
        new URL(request.url).searchParams.get('cursor') === 'c2' ? second : first,
    })
    renderApp('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Carregar mais' }))
    expect(await screen.findByText('Terceira gravação')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('radio', { name: 'Compartilhadas comigo' }))
    await screen.findAllByRole('listitem')
    const owners = http.requests('GET /api/v1/recordings').map((r) => new URL(r.url).searchParams.get('owner'))
    expect(owners).toContain('shared')
  })

  it('biblioteca vazia convida a importar', async () => {
    mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/recordings': () => ({ items: [], next_cursor: null }),
    })
    renderApp('/')
    expect(await screen.findByRole('heading', { name: 'Nenhuma gravação ainda' })).toBeInTheDocument()
  })
})
