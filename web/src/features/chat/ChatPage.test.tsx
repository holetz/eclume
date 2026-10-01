import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'
import { BASE_CHAT_POLL_MS } from './baseChat'

beforeAll(() => preloadRoute('/perguntas'))

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

function mockChat(steps: ReturnType<typeof fixtures.baseChatDone>[], extra: Parameters<typeof mockFetch>[0] = {}) {
  let polls = 0
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'POST /api/v1/base-chat': () => fixtures.baseChatQueued(),
    'GET /api/v1/base-chat/:id': () => steps[Math.min(polls++, steps.length - 1)],
    ...extra,
  })
}

async function ask(text: string) {
  await userEvent.type(await screen.findByRole('textbox', { name: 'Pergunta' }), text)
  await userEvent.click(screen.getByRole('button', { name: 'Perguntar' }))
}

describe('Perguntas', () => {
  it('está na navegação e abre a tela com exemplos', async () => {
    mockChat([fixtures.baseChatDone()])
    renderApp('/perguntas')
    expect(await screen.findByRole('heading', { level: 1, name: 'Perguntas' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Perguntar' })).toHaveAttribute('href', '/perguntas')
    expect(screen.getByRole('button', { name: /Quais decisões foram tomadas/ })).toBeInTheDocument()
  })

  it('envia a pergunta, espera a resposta e mostra as fontes com link', async () => {
    const running = {
      ...fixtures.baseChatQueued(),
      status: 'running' as const,
    }
    const http = mockChat([running, fixtures.baseChatDone()])
    renderApp('/perguntas')
    await ask('Qual orçamento ficou combinado?')

    const log = await screen.findByRole('log', { name: 'Conversa' })
    expect(await within(log).findByText('Qual orçamento ficou combinado?')).toBeInTheDocument()
    expect(await within(log).findByLabelText('Consultando as gravações')).toBeInTheDocument()
    expect(await http.requests('POST /api/v1/base-chat')[0].json()).toEqual({
      message: 'Qual orçamento ficou combinado?',
      history: [],
    })

    await advance(BASE_CHAT_POLL_MS)
    await advance(BASE_CHAT_POLL_MS)
    expect(await within(log).findByText(/R\$ 40 mil/)).toBeInTheDocument()
    const sources = within(log).getByRole('list', { name: 'Fontes' })
    expect(within(sources).getByRole('link', { name: 'Kickoff Serra Azul' })).toHaveAttribute(
      'href',
      '/gravacoes/01928f3a-1c00-7a00-8000-000000000201',
    )
    expect(within(log).getByText('Fez 2 consultas às gravações')).toBeInTheDocument()
    const polls = http.requests('GET /api/v1/base-chat/:id').length
    await advance(BASE_CHAT_POLL_MS * 3)
    expect(http.requests('GET /api/v1/base-chat/:id')).toHaveLength(polls)
  })

  it('reenvia a conversa até aqui como histórico na pergunta seguinte', async () => {
    const http = mockChat([fixtures.baseChatDone()])
    renderApp('/perguntas')
    await ask('Primeira?')
    await screen.findByText(/R\$ 40 mil/)
    await ask('E o prazo?')
    await waitFor(() => expect(http.requests('POST /api/v1/base-chat')).toHaveLength(2))
    const body = await http.requests('POST /api/v1/base-chat')[1].json()
    expect(body.message).toBe('E o prazo?')
    expect(body.history).toEqual([
      { role: 'user', content: 'Primeira?' },
      { role: 'assistant', content: expect.stringContaining('R$ 40 mil') },
    ])
  })

  it('explica a falta de agente e deixa tentar de novo', async () => {
    const http = mockChat([fixtures.baseChatFailed()])
    renderApp('/perguntas')
    await ask('Algo?')
    expect(await screen.findByText(/ainda não tem um agente configurado/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await waitFor(() => expect(http.requests('POST /api/v1/base-chat')).toHaveLength(2))
  })

  it('mostra o limite de perguntas em aberto', async () => {
    mockChat([fixtures.baseChatDone()], {
      'POST /api/v1/base-chat': () =>
        problem('rate_limited', 429, {
          detail: 'Já há 2 perguntas em andamento.',
        }),
    })
    renderApp('/perguntas')
    await ask('Muitas')
    expect(await screen.findByRole('alert')).toHaveTextContent(/Muitas requisições seguidas/)
  })

  it('avisa que a pergunta expirou', async () => {
    mockChat([], {
      'GET /api/v1/base-chat/:id': () => problem('not_found', 404),
    })
    renderApp('/perguntas')
    await ask('Antiga')
    expect(await screen.findByText(/Esta pergunta expirou/)).toBeInTheDocument()
  })
})
