import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, json, mockFetch } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/app-movel', '/parear'))

const SERVER_DATE = 'Sun, 27 Sep 2026 14:02:18 GMT'

// Só a data e o `performance.now()` (a âncora da contagem) são falsos, no instante do servidor da
// fixture: a validade não depende do relógio real. Os temporizadores ficam reais, para o React Query
// e o Testing Library.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] })
  vi.setSystemTime(new Date(SERVER_DATE))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function devicePage() {
  const page = fixtures.tokenPage()
  const [desktop] = page.items
  page.items = [
    desktop,
    {
      ...desktop,
      id: '01928f3a-1c00-7a00-8000-000000000705',
      name: 'Pixel 8 · Mariana',
      platform: 'android',
      created_at: '2026-09-12T10:20:00Z',
      last_used_at: null,
    },
  ]
  return page
}

function mockMobileApi(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'POST /api/v1/devices/pairing-codes': () => json(fixtures.pairingCodeCreated(), 201, { Date: SERVER_DATE }),
    'GET /api/v1/devices/pairing-codes/:id': () => ({ ...fixtures.pairingCodeUsed(), status: 'pending', token_id: null }),
    'GET /api/v1/tokens': () => devicePage(),
    ...extra,
  })
}

describe('app móvel', () => {
  it('gera o código ao abrir e mostra o QR, os passos, a validade e o código em texto', async () => {
    const http = mockMobileApi()
    renderApp('/app-movel')
    expect(await screen.findByRole('heading', { name: 'App móvel' })).toBeInTheDocument()
    const qr = await screen.findByRole('img', { name: 'Código QR para parear o celular' })
    expect(qr.querySelectorAll('path').length).toBeGreaterThan(10)
    expect(qr.querySelector('path')).toHaveAttribute('fill', '#000')
    expect(screen.getByText('Toque em Ler um código')).toBeInTheDocument()
    expect(screen.getByText(/Válido por 9:42/)).toBeInTheDocument()
    expect(screen.getByText('K7Q-4MX')).toBeInTheDocument()
    expect(http.requests('POST /api/v1/devices/pairing-codes').length).toBeGreaterThanOrEqual(1)
  })

  it('lista só os celulares vinculados e desvincula depois de confirmar', async () => {
    const http = mockMobileApi({ 'DELETE /api/v1/tokens/:id': () => empty(204) })
    renderApp('/app-movel')
    const list = await screen.findByRole('region', { name: 'Celulares vinculados' })
    expect(await within(list).findByText('Pixel 8 · Mariana')).toBeInTheDocument()
    expect(within(list).getByText(/Pareado em 12\/09 · ainda sem sincronização/)).toBeInTheDocument()
    expect(within(list).queryByText('Desktop — notebook da Mariana')).not.toBeInTheDocument()
    const tokens = http.requests('GET /api/v1/tokens')
    expect(new URL(tokens[0].url).searchParams.get('kind')).toBe('device')

    await userEvent.click(within(list).getByRole('button', { name: 'Desvincular Pixel 8 · Mariana' }))
    const dialog = screen.getByRole('dialog', { name: 'Desvincular Pixel 8 · Mariana?' })
    expect(within(dialog).getByText('O celular para de sincronizar até entrar de novo.')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Desvincular' }))
    await vi.waitFor(() => expect(http.requests('DELETE /api/v1/tokens/:id')).toHaveLength(1))
    expect(new URL(http.requests('DELETE /api/v1/tokens/:id')[0].url).pathname).toBe(
      '/api/v1/tokens/01928f3a-1c00-7a00-8000-000000000705',
    )
  })

  it('sem celulares, diz que nenhum está vinculado', async () => {
    mockMobileApi({ 'GET /api/v1/tokens': () => ({ items: [], next_cursor: null }) })
    renderApp('/app-movel')
    expect(await screen.findByText('Nenhum celular vinculado ainda.')).toBeInTheDocument()
  })
})

describe('página de pareamento', () => {
  it('é pública, mostra o código formatado e não chama a API', async () => {
    const http = mockFetch({})
    renderApp('/parear?codigo=K7Q4MX&ca=3f9a')
    expect(await screen.findByRole('heading', { name: 'Parear o celular' })).toBeInTheDocument()
    expect(screen.getByText('K7Q-4MX')).toBeInTheDocument()
    expect(screen.getByText(/Abra o app no celular e toque em Ler um código/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Entrar no eclume' })).toHaveAttribute('href', '/entrar')
    expect(http.calls).toHaveLength(0)
  })
})
