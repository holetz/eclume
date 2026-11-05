import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setLocale } from '../../i18n'
import { fixtures } from '../../test/fixtures'
import { json } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'
import { mockTranscriptApi, RECORDING_ID as RECORDING } from '../../test/transcriptApi'
import { readNote } from './chat'
import { originLabel } from './summary'

beforeAll(() => preloadRoute('/gravacoes/x', '/config/agendas'))

afterEach(() => vi.unstubAllGlobals())

async function chat() {
  const aside = await screen.findByRole('complementary', { name: 'Ajustar o resumo' })
  await within(aside).findAllByText('Você')
  return aside
}

function composer(aside: HTMLElement) {
  return within(aside).getByRole('textbox', { name: 'Pedido de ajuste' })
}

describe('summary adjustment chat', () => {
  it('shows the history, with the notes of what the agent read from the transcript', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const aside = await chat()
    expect(aside).toHaveClass('chat')
    expect(aside).toHaveTextContent('Trabalha sobre o resumo. Só lê a transcrição quando o pedido precisa.')
    const log = within(aside).getByRole('log', { name: 'Conversa' })
    expect(log).toHaveAttribute('aria-live', 'polite')
    const [user, agent] = log.querySelectorAll('.msg')
    expect(user).toHaveClass('msg-user')
    expect(user).toHaveTextContent('VocêQuem falou do orçamento? Coloque isso nas decisões.')
    expect(agent).toHaveClass('msg-agent')
    const notes = [...agent.querySelectorAll('.msg-note')].map((note) => note.textContent)
    expect(notes).toEqual(['Buscou “orçamento” na transcrição · 2 trechos', 'Leu a transcrição, 00:01:00–00:01:30'])
    expect(agent).toHaveTextContent('Foi a Mariana Couto, aos 00:01:05.')
    expect(composer(aside)).toHaveAttribute('placeholder', 'Peça uma mudança, por exemplo: liste as decisões em tabela')
    expect(composer(aside)).toHaveAttribute('maxLength', '4000')
    expect(aside).toHaveTextContent('Cada mudança vira uma versão')
  })

  it('sends, follows the response until done and rereads the summary with the new version', async () => {
    const user = userEvent.setup()
    let polls = 0
    const http = mockTranscriptApi({
      'POST /api/v1/recordings/:id/summary/chat': () => json(fixtures.summaryChatExchangeQueued(), 202),
      'GET /api/v1/summary-chat-messages/:id': () => {
        polls++
        const reply = fixtures.summaryChatExchangeQueued().reply
        return polls < 2
          ? { ...reply, status: 'running' }
          : { ...reply, status: 'done', content: 'Pronto: as decisões estão em tabela.', summary_id: 'nova-versao' }
      },
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const aside = await chat()
    await user.type(composer(aside), 'Liste as decisões em tabela.')
    await user.click(within(aside).getByRole('button', { name: 'Enviar' }))

    expect(await within(aside).findByLabelText('Trabalhando')).toBeInTheDocument()
    expect(composer(aside)).toHaveValue('')
    expect(within(aside).getByRole('button', { name: 'Enviar' })).toBeDisabled()
    expect(aside).toHaveTextContent('Há um pedido em andamento; espere a resposta.')
    expect(await http.requests('POST /api/v1/recordings/:id/summary/chat')[0].json()).toEqual({
      message: 'Liste as decisões em tabela.',
    })

    const summaryReads = http.requests('GET /api/v1/recordings/:id/summary').length
    expect(
      await within(aside).findByText('Pronto: as decisões estão em tabela.', {}, { timeout: 6000 }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(http.requests('GET /api/v1/recordings/:id/summary').length).toBeGreaterThan(summaryReads),
    )
    expect(within(aside).queryByLabelText('Trabalhando')).not.toBeInTheDocument()
  }, 15_000)

  it('after an adjustment, takes the request to the draft of the agenda type instructions, without saving', async () => {
    const http = mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const aside = await chat()
    const link = await within(aside).findByRole('link', { name: 'Levar este pedido para as instruções do tipo' })
    expect(link).toHaveAttribute('href', '/config/agendas?tipo=01928f3a-1c00-7a00-8000-000000000901')
    await userEvent.click(link)
    const panel = await screen.findByRole('form', { name: 'Editar Reunião de equipe' })
    const instructions = within(panel).getByLabelText('Instruções do resumo') as HTMLTextAreaElement
    expect(instructions.value).toMatch(/responsável, o quê e quando\.\n\nQuem falou do orçamento\? Coloque isso nas decisões\.$/)
    expect(within(panel).getByRole('status')).toHaveTextContent('O pedido do chat entrou no fim das instruções do resumo.')
    expect(within(panel).getByRole('button', { name: 'Salvar' })).toBeEnabled()
    expect(http.requests('PATCH /api/v1/agenda-types/:id')).toHaveLength(0)
  })

  it('with no adjustment that changed the summary, does not offer taking the request to the agenda type', async () => {
    const page = fixtures.summaryChatPage()
    page.items[1] = { ...page.items[1], summary_id: null }
    mockTranscriptApi({ 'GET /api/v1/recordings/:id/summary/chat': () => page })
    renderApp(`/gravacoes/${RECORDING}`)
    const aside = await chat()
    expect(within(aside).queryByRole('link', { name: /Levar este pedido/ })).not.toBeInTheDocument()
  })

  it('Ctrl+Enter sends; the summary that changed meanwhile and the failure become a note and a retry', async () => {
    const user = userEvent.setup()
    const page = fixtures.summaryChatPage()
    page.items.push(
      { ...page.items[0], id: 'u2', content: 'Encurte o resumo.' },
      {
        ...page.items[1],
        id: 'a2',
        reply_to: 'u2',
        content: 'Encurtei.',
        summary_id: null,
        error: { code: 'summary_changed', message: 'O resumo mudou.' },
      },
      { ...page.items[0], id: 'u3', content: 'Tire os nomes.' },
      {
        ...page.items[1],
        id: 'a3',
        reply_to: 'u3',
        status: 'failed',
        content: null,
        reads: [],
        error: { code: 'provider_timeout', message: 'O agente não respondeu a tempo.' },
      },
    )
    const http = mockTranscriptApi({
      'GET /api/v1/recordings/:id/summary/chat': () => page,
      'POST /api/v1/recordings/:id/summary/chat': () => json(fixtures.summaryChatExchangeQueued(), 202),
      'GET /api/v1/summary-chat-messages/:id': () => ({
        ...fixtures.summaryChatExchangeQueued().reply,
        status: 'running',
      }),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const aside = await chat()
    expect(
      await within(aside).findByText('O resumo mudou enquanto eu trabalhava; nada foi alterado. Peça de novo.'),
    ).toHaveClass('msg-note')
    expect(aside).toHaveTextContent('O agente não respondeu a tempo.')
    await user.click(within(aside).getByRole('button', { name: 'Tentar de novo' }))
    await waitFor(() => expect(http.requests('POST /api/v1/recordings/:id/summary/chat')).toHaveLength(1))
    expect(await http.requests('POST /api/v1/recordings/:id/summary/chat')[0].json()).toEqual({
      message: 'Tire os nomes.',
    })
  })

  it('with no summary, the composer waits; with an open request on the server (409), it warns', async () => {
    const user = userEvent.setup()
    mockTranscriptApi({
      'POST /api/v1/recordings/:id/summary/chat': () =>
        json({ type: 'about:blank', title: 'chat_busy', status: 409, code: 'chat_busy' }, 409),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const aside = await chat()
    await user.type(composer(aside), 'Mais curto.{Control>}{Enter}{/Control}')
    expect(await within(aside).findByText('Há um pedido em andamento; espere a resposta.')).toBeInTheDocument()
    expect(within(aside).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('with no current summary, the chat is unavailable', async () => {
    mockTranscriptApi({
      'GET /api/v1/recordings/:id/summary': () => ({ current: null, generated: null, pending: null, version_count: 0 }),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const aside = await chat()
    expect(await within(aside).findByText('O chat fica disponível quando houver um resumo.')).toBeInTheDocument()
    expect(composer(aside)).toBeDisabled()
  })
})

describe('the summary chat in English', () => {
  it('reads its notes and the summary origin from the transcript catalog', async () => {
    await setLocale('en')
    try {
      expect(readNote({ tool: 'search_transcript', query: 'budget', hits: 3 } as never)).toBe(
        'Searched “budget” in the transcript · 3 passages',
      )
      expect(readNote({ tool: 'read_transcript', from_ms: 0, to_ms: 60_000, clipped: true } as never)).toMatch(
        /^Read the transcript, .+ \(clipped\)$/,
      )
      expect(originLabel({ origin: 'chat', restored_from_id: null })).toBe('Adjusted by the chat')
    } finally {
      await setLocale('pt-BR')
    }
  })
})
