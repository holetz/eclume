import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/agente/conversas'))
afterEach(() => vi.unstubAllGlobals())

const named = { ...fixtures.agentSession(), title: 'Prazos do kickoff', updated_at: '2026-10-05T13:02:10Z' }
const untitled = { ...fixtures.agentSession(), id: '01928f3a-1c00-7a00-8000-000000000a02', title: '' }

function mockSessions(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/agent/sessions': (request: Request) =>
      new URL(request.url).searchParams.get('cursor')
        ? { items: [untitled], next_cursor: null }
        : { items: [named], next_cursor: 'c2' },
    'PATCH /api/v1/agent/sessions/:id': async (request: Request) => ({ ...named, ...(await request.json()) }),
    'DELETE /api/v1/agent/sessions/:id': () => empty(),
    ...extra,
  })
}

describe('Conversations', () => {
  it('lists the conversations with link, date and more pages, and sits in the Agente menu group', async () => {
    mockSessions()
    renderApp('/agente/conversas')
    expect(await screen.findByRole('heading', { level: 1, name: 'Conversas' })).toBeInTheDocument()
    const list = await screen.findByRole('list', { name: 'Conversas' })
    expect(within(list).getByRole('link', { name: 'Prazos do kickoff' })).toHaveAttribute('href', `/agente/${named.id}`)
    expect(within(list).getByText(/Última atividade em 05\/10\/2026.*10:02/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Carregar mais' }))
    expect(await within(list).findByRole('link', { name: 'Conversa sem título' })).toBeInTheDocument()

    const nav = screen.getByRole('navigation', { name: 'Principal' })
    const group = within(nav).getByRole('group', { name: 'Agente' })
    expect(within(group).getByRole('link', { name: 'Conversas' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Agente' })).not.toHaveAttribute('aria-current')
  })

  it('renames the conversation', async () => {
    const http = mockSessions()
    renderApp('/agente/conversas')
    await userEvent.click(await screen.findByRole('button', { name: 'Renomear Prazos do kickoff' }))
    const field = screen.getByRole('textbox', { name: 'Título' })
    await userEvent.clear(field)
    await userEvent.type(field, 'Prazos de março')
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(http.requests('PATCH /api/v1/agent/sessions/:id')).toHaveLength(1))
    expect(await http.requests('PATCH /api/v1/agent/sessions/:id')[0].json()).toEqual({ title: 'Prazos de março' })
  })

  it('deletes the conversation after confirming', async () => {
    const http = mockSessions()
    renderApp('/agente/conversas')
    await userEvent.click(await screen.findByRole('button', { name: 'Excluir Prazos do kickoff' }))
    const dialog = screen.getByRole('dialog', { name: 'Excluir conversa' })
    expect(dialog).toHaveTextContent('sai com as mensagens, os anexos e os arquivos gerados')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }))
    await waitFor(() => expect(http.requests('DELETE /api/v1/agent/sessions/:id')).toHaveLength(1))
  })

  it('with no conversation, invites a question', async () => {
    mockSessions({ 'GET /api/v1/agent/sessions': () => ({ items: [], next_cursor: null }) })
    renderApp('/agente/conversas')
    expect(await screen.findByText(/Nenhuma conversa ainda/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Pergunte ao Agente' })).toHaveAttribute('href', '/agente')
  })
})
