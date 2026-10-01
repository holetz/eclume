import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, json, mockFetch } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/tokens'))

afterEach(() => vi.unstubAllGlobals())

function mockTokensApi(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/tokens': () => fixtures.tokenPage(),
    ...extra,
  })
}

describe('tokens de acesso', () => {
  it('lista os tokens com o resumo dos escopos, a validade, o uso e o aparelho marcado', async () => {
    mockTokensApi()
    renderApp('/tokens')
    expect(await screen.findByRole('heading', { name: 'Tokens de acesso' })).toBeInTheDocument()
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Desktop — notebook da Mariana')
    expect(within(rows[0]).getByText('Aparelho · Windows')).toBeInTheDocument()
    expect(within(rows[1]).getByText('transcripts:read, people:read')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Nunca')).toBeInTheDocument()
    expect(within(rows[1]).queryByText(/Aparelho/)).not.toBeInTheDocument()
  })

  it('leva à referência da API servida pelo próprio servidor', async () => {
    mockTokensApi()
    renderApp('/tokens')
    const link = await screen.findByRole('link', { name: 'Referência da API' })
    expect(link).toHaveAttribute('href', '/referencia-api.html')
  })

  it('põe os revogados no fim e marca os expirados', async () => {
    const page = fixtures.tokenPage()
    page.items[0].revoked_at = '2026-09-20T10:00:00Z'
    page.items[1].expires_at = '2026-01-01T00:00:00Z'
    mockTokensApi({ 'GET /api/v1/tokens': () => page })
    renderApp('/tokens')
    const rows = within(await screen.findByRole('table')).getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('lumea — importador')
    expect(within(rows[0]).getByText('Expirado')).toBeInTheDocument()
    expect(rows[1]).toHaveTextContent(/Revogado em/)
    expect(within(rows[1]).queryByRole('button', { name: /Revogar/ })).not.toBeInTheDocument()
  })

  it('cria pelo diálogo com grupos e validade, e mostra o segredo uma vez', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const http = mockTokensApi({ 'POST /api/v1/tokens': () => json(fixtures.tokenCreated(), 201) })
    renderApp('/tokens')
    await userEvent.click(await screen.findByRole('button', { name: 'Novo token' }))
    const dialog = screen.getByRole('dialog', { name: 'Novo token' })
    const create = within(dialog).getByRole('button', { name: 'Criar token' })
    expect(create).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Script de backup')
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Buscar e ler gravações' }))
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Ler e editar resumos' }))
    await userEvent.click(within(dialog).getByRole('radio', { name: '30 dias' }))
    await userEvent.click(create)

    const alert = await screen.findByRole('region', { name: /Token “lumea — importador” criado/ })
    expect(within(alert).getByText('Ele só aparece uma vez.')).toBeInTheDocument()
    expect(within(alert).getByText('eclp_7Hq2vN4kR8sT1wX6yZ3bC5dF0gJ9mP2a')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Novo token' })).not.toBeInTheDocument()
    await userEvent.click(within(alert).getByRole('button', { name: 'Copiar' }))
    expect(writeText).toHaveBeenCalledWith('eclp_7Hq2vN4kR8sT1wX6yZ3bC5dF0gJ9mP2a')

    const body = await http.requests('POST /api/v1/tokens')[0].json()
    expect(body.name).toBe('Script de backup')
    expect(body.scopes).toEqual(['recordings:read', 'transcripts:read', 'summaries:read', 'summaries:write'])
    const days = (new Date(body.expires_at).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThan(30.1)

    await userEvent.click(within(alert).getByRole('button', { name: 'Pronto, já guardei' }))
    expect(screen.queryByText('eclp_7Hq2vN4kR8sT1wX6yZ3bC5dF0gJ9mP2a')).not.toBeInTheDocument()
  })

  it('usa a combinação do lumea nos escopos individuais', async () => {
    const http = mockTokensApi({ 'POST /api/v1/tokens': () => json(fixtures.tokenCreated(), 201) })
    renderApp('/tokens')
    await userEvent.click(await screen.findByRole('button', { name: 'Novo token' }))
    const dialog = screen.getByRole('dialog', { name: 'Novo token' })
    await userEvent.click(within(dialog).getByText('Escopos individuais'))
    await userEvent.click(within(dialog).getByRole('button', { name: 'lumea' }))
    expect(within(dialog).getByLabelText('Nome')).toHaveValue('lumea — importador')
    expect(within(dialog).getByRole('checkbox', { name: /Ler pessoas/ })).toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: 'Buscar e ler gravações' })).not.toBeChecked()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Criar token' }))
    await screen.findByRole('region', { name: /criado/ })
    const body = await http.requests('POST /api/v1/tokens')[0].json()
    expect(body.scopes).toEqual(['transcripts:read', 'people:read'])
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000)
  })

  it('revoga só depois de confirmar no diálogo', async () => {
    const http = mockTokensApi({ 'DELETE /api/v1/tokens/:id': () => empty(204) })
    renderApp('/tokens')
    await userEvent.click(await screen.findByRole('button', { name: 'Revogar lumea — importador' }))
    const dialog = screen.getByRole('dialog', { name: 'Revogar lumea — importador?' })
    expect(within(dialog).getByText('Quem usa este token perde o acesso.')).toBeInTheDocument()
    expect(http.requests('DELETE /api/v1/tokens/:id')).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revogar' }))
    await vi.waitFor(() => expect(http.requests('DELETE /api/v1/tokens/:id')).toHaveLength(1))
    expect(new URL(http.requests('DELETE /api/v1/tokens/:id')[0].url).pathname).toBe(
      '/api/v1/tokens/01928f3a-1c00-7a00-8000-000000000701',
    )
  })

  it('avisa que revogar um aparelho o desliga', async () => {
    mockTokensApi()
    renderApp('/tokens')
    await userEvent.click(await screen.findByRole('button', { name: 'Revogar Desktop — notebook da Mariana' }))
    expect(screen.getByText('O aparelho para de sincronizar até entrar de novo.')).toBeInTheDocument()
  })
})
