import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { json, mockFetch } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/config/mcp'))

afterEach(() => vi.unstubAllGlobals())

function mockMcpApi(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/server': () => fixtures.serverInfo(),
    ...extra,
  })
}

describe('MCP connection', () => {
  it('shows the descriptor MCP address to copy and the steps', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mockMcpApi()
    renderApp('/config/mcp')
    expect(await screen.findByRole('heading', { name: 'Conexão MCP' })).toBeInTheDocument()
    expect(await screen.findByText('https://192.0.2.10:8443/mcp')).toBeInTheDocument()
    const steps = document.querySelector<HTMLElement>('ol.steps')!
    expect(steps).toHaveTextContent('Crie um token para o assistente')
    expect(within(steps).getByRole('link', { name: 'Tokens de acesso' })).toHaveAttribute('href', '/tokens')
    await userEvent.click(screen.getAllByRole('button', { name: 'Copiar' })[0])
    expect(writeText).toHaveBeenCalledWith('https://192.0.2.10:8443/mcp')
  })

  it('suggests the assistant token without deleting recordings and with 90 days', async () => {
    mockMcpApi()
    renderApp('/config/mcp')
    const panel = await screen.findByRole('region', { name: 'Novo token para um assistente' })
    expect(within(panel).getByLabelText('Nome')).toHaveValue('Claude Desktop')
    expect(within(panel).getByRole('checkbox', { name: 'Buscar e ler gravações' })).toBeChecked()
    expect(within(panel).getByRole('checkbox', { name: 'Ler e editar resumos' })).toBeChecked()
    expect(within(panel).getByRole('checkbox', { name: 'Editar campos e tags' })).toBeChecked()
    expect(within(panel).getByRole('checkbox', { name: 'Excluir gravações' })).not.toBeChecked()
    expect(within(panel).getByRole('radio', { name: '90 dias' })).toBeChecked()
    expect(within(panel).queryByText('Escopos individuais')).not.toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: 'Sobre excluir gravações' }))
    expect(screen.getByRole('dialog', { name: 'Excluir gravações' })).toHaveTextContent(
      'pode apagar gravações se a transcrição pedir',
    )
  })

  it('creates the token and shows the secret and the Claude Code command', async () => {
    const created = fixtures.tokenCreated()
    created.token.name = 'Claude Desktop'
    const http = mockMcpApi({ 'POST /api/v1/tokens': () => json(created, 201) })
    renderApp('/config/mcp')
    const panel = await screen.findByRole('region', { name: 'Novo token para um assistente' })
    await screen.findByText('https://192.0.2.10:8443/mcp')
    await userEvent.click(within(panel).getByRole('button', { name: 'Criar token' }))

    expect(await within(panel).findByText(/Token “Claude Desktop” criado/)).toBeInTheDocument()
    expect(within(panel).getByText('eclp_7Hq2vN4kR8sT1wX6yZ3bC5dF0gJ9mP2a')).toBeInTheDocument()
    expect(
      within(panel).getByText(
        'claude mcp add --transport http eclume https://192.0.2.10:8443/mcp --header "Authorization: Bearer eclp_7Hq2vN4kR8sT1wX6yZ3bC5dF0gJ9mP2a"',
      ),
    ).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'Como instalar o certificado' })).toHaveAttribute(
      'href',
      '/ajuda/certificado-do-servidor',
    )

    const body = await http.requests('POST /api/v1/tokens')[0].json()
    expect(body.name).toBe('Claude Desktop')
    expect(body.scopes).not.toContain('recordings:delete')
    expect(body.scopes).toEqual(
      expect.arrayContaining(['recordings:read', 'transcripts:read', 'summaries:read', 'summaries:write', 'recordings:write']),
    )
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000)

    await userEvent.click(within(panel).getByRole('button', { name: 'Criar outro token' }))
    expect(within(panel).getByRole('button', { name: 'Criar token' })).toBeInTheDocument()
  })
})
