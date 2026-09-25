import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, json, mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'
import { expiresAt } from './scopes'

afterEach(() => vi.unstubAllGlobals())

function mockTokensApi(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/tokens': () => fixtures.tokenPage(),
    ...extra,
  })
}

describe('tokens de acesso', () => {
  it('lista os tokens com escopos, uso e validade', async () => {
    mockTokensApi()
    renderApp('/tokens')
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByRole('rowheader')).toHaveTextContent('Desktop — notebook da Mariana')
    expect(within(rows[0]).getByText('eclp_Qm9x…')).toBeInTheDocument()
    expect(within(rows[0]).getByText('Enviar gravações')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Não expira')).toBeInTheDocument()
  })

  it('cria com escopos, mostra o segredo uma vez e permite copiar', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const http = mockTokensApi({ 'POST /api/v1/tokens': () => json(fixtures.tokenCreated(), 201) })
    renderApp('/tokens')
    const create = await screen.findByRole('button', { name: 'Criar token' })
    expect(create).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'lumea' }))
    expect(screen.getByLabelText('Nome')).toHaveValue('lumea — importador')
    expect(screen.getByRole('checkbox', { name: /Ler transcrições/ })).toBeChecked()
    await userEvent.selectOptions(screen.getByLabelText('Validade'), '90')
    await userEvent.click(create)

    const panel = await screen.findByRole('region', { name: /Token “lumea — importador” criado/ })
    expect(within(panel).getByLabelText('Token')).toHaveValue('eclp_7Hq2vN4kR8sT1wX6yZ3bC5dF0gJ9mP2a')
    expect(within(panel).getByText(/não será mostrado de novo/)).toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: 'Copiar' }))
    expect(writeText).toHaveBeenCalledWith('eclp_7Hq2vN4kR8sT1wX6yZ3bC5dF0gJ9mP2a')
    expect(within(panel).getByRole('button', { name: 'Copiado' })).toBeInTheDocument()

    const body = await http.requests('POST /api/v1/tokens')[0].json()
    expect(body.name).toBe('lumea — importador')
    expect(body.scopes).toEqual(['transcripts:read', 'people:read'])
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000)

    await userEvent.click(within(panel).getByRole('button', { name: 'Pronto, já guardei' }))
    expect(screen.queryByText('eclp_7Hq2vN4kR8sT1wX6yZ3bC5dF0gJ9mP2a')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('eclp_7Hq2vN4kR8sT1wX6yZ3bC5dF0gJ9mP2a')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Novo token' })).toBeInTheDocument()
  })

  it('revoga só depois de confirmar', async () => {
    const http = mockTokensApi({ 'DELETE /api/v1/tokens/:id': () => empty(204) })
    renderApp('/tokens')
    await userEvent.click(await screen.findByRole('button', { name: 'Revogar lumea — importador' }))
    expect(http.requests('DELETE /api/v1/tokens/:id')).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar revogação' }))
    expect(await screen.findByText(/Revogado em/)).toBeInTheDocument()
    expect(new URL(http.requests('DELETE /api/v1/tokens/:id')[0].url).pathname).toBe(
      '/api/v1/tokens/01928f3a-1c00-7a00-8000-000000000701',
    )
    expect(screen.queryByRole('button', { name: 'Revogar lumea — importador' })).not.toBeInTheDocument()
  })

  it('calcula a validade', () => {
    const now = new Date('2026-09-24T12:00:00Z')
    expect(expiresAt(null, now)).toBeNull()
    expect(expiresAt(30, now)).toBe('2026-10-24T12:00:00.000Z')
  })
})
