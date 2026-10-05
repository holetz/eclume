import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/agente/habilidades'))
afterEach(() => vi.unstubAllGlobals())

const ata = {
  id: '01928f3a-1c00-7a00-8000-000000000b01',
  name: 'ata',
  description: 'Escreve a ata de uma reunião com decisões e prazos.',
  instructions: '## Ata\n\n- Decisões\n- Prazos',
  allowed_tools: null,
  enabled: true,
  created_at: '2026-10-05T13:00:00Z',
  updated_at: '2026-10-05T13:00:00Z',
}
const tools = [
  { name: 'search_summaries', kind: 'read', description: 'Busca nos resumos das gravações.' },
  { name: 'write_file', kind: 'produce', description: 'Gera um arquivo .md, .txt, .csv ou .docx para baixar.' },
  { name: 'tag_recordings', kind: 'action', description: 'Propõe aplicar ou remover tags em lote.' },
]

function mockSkills(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/agent/skills': () => ({ items: [ata] }),
    'GET /api/v1/agent/tools': () => ({ items: tools }),
    'POST /api/v1/agent/skills': async (request: Request) => ({ ...ata, ...(await request.json()), id: 'nova' }),
    'PATCH /api/v1/agent/skills/:id': async (request: Request) => ({ ...ata, ...(await request.json()) }),
    'DELETE /api/v1/agent/skills/:id': () => empty(),
    ...extra,
  })
}

describe('Habilidades', () => {
  it('lista as habilidades e está no grupo Agente do menu', async () => {
    mockSkills()
    renderApp('/agente/habilidades')
    expect(await screen.findByRole('heading', { level: 1, name: 'Habilidades' })).toBeInTheDocument()
    const list = await screen.findByRole('list', { name: 'Habilidades' })
    expect(within(list).getByText('/ata')).toBeInTheDocument()
    expect(within(list).getByText(/Escreve a ata de uma reunião/)).toBeInTheDocument()

    const nav = screen.getByRole('navigation', { name: 'Principal' })
    const group = within(nav).getByRole('group', { name: 'Agente' })
    expect(within(group).getByRole('link', { name: 'Habilidades' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Agente' })).not.toHaveAttribute('aria-current')
  })

  it('cria uma habilidade com as ferramentas permitidas', async () => {
    const http = mockSkills()
    renderApp('/agente/habilidades')
    await userEvent.click(await screen.findByRole('button', { name: 'Nova habilidade' }))
    const dialog = screen.getByRole('dialog', { name: 'Nova habilidade' })
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Nome' }), '/Checklist')
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Descrição' }), 'Confere a pauta da reunião.')
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Instruções' }), 'Confira cada item.')
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Limitar as ferramentas que a habilidade usa' }))
    expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeDisabled()
    await userEvent.click(await within(dialog).findByRole('checkbox', { name: /Busca nos resumos/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(http.requests('POST /api/v1/agent/skills')).toHaveLength(1))
    expect(await http.requests('POST /api/v1/agent/skills')[0].json()).toEqual({
      name: 'checklist',
      description: 'Confere a pauta da reunião.',
      instructions: 'Confira cada item.',
      allowed_tools: ['search_summaries'],
    })
  })

  it('recusa nome fora do padrão antes de enviar', async () => {
    mockSkills()
    renderApp('/agente/habilidades')
    await userEvent.click(await screen.findByRole('button', { name: 'Nova habilidade' }))
    const dialog = screen.getByRole('dialog', { name: 'Nova habilidade' })
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Nome' }), 'ata nova')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('de 2 a 40 letras minúsculas')
    expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeDisabled()
  })

  it('desliga e exclui depois de confirmar', async () => {
    const http = mockSkills()
    renderApp('/agente/habilidades')
    await userEvent.click(await screen.findByRole('button', { name: 'Desligar /ata' }))
    await waitFor(() => expect(http.requests('PATCH /api/v1/agent/skills/:id')).toHaveLength(1))
    expect(await http.requests('PATCH /api/v1/agent/skills/:id')[0].json()).toEqual({ enabled: false })

    await userEvent.click(screen.getByRole('button', { name: 'Excluir /ata' }))
    const dialog = screen.getByRole('dialog', { name: 'Excluir habilidade' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }))
    await waitFor(() => expect(http.requests('DELETE /api/v1/agent/skills/:id')).toHaveLength(1))
  })

  it('sem habilidade, explica como criar', async () => {
    mockSkills({ 'GET /api/v1/agent/skills': () => ({ items: [] }) })
    renderApp('/agente/habilidades')
    expect(await screen.findByText(/Nenhuma habilidade ainda/)).toBeInTheDocument()
  })
})
