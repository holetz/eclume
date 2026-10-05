import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'
import { AGENT_POLL_MS } from './agent'

beforeAll(() => preloadRoute('/agente'))

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

const SESSION = fixtures.agentSession().id

function emptyDetail() {
  return { ...fixtures.agentSession(), messages: [], pending_files: [] }
}

function mockAgent(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/agent/sessions': () => ({ items: [fixtures.agentSession()], next_cursor: null }),
    'POST /api/v1/agent/sessions': () => fixtures.agentSession(),
    'GET /api/v1/agent/sessions/:id': () => emptyDetail(),
    'POST /api/v1/agent/sessions/:id/messages': () => fixtures.agentTurn(),
    'GET /api/v1/agent/sessions/:id/messages/:mid': () => fixtures.agentMessageDone(),
    'POST /api/v1/agent/sessions/:id/files': () => fixtures.agentFileInput(),
    'DELETE /api/v1/agent/sessions/:id/files/:fid': () => empty(),
    'GET /api/v1/agent/skills': () => ({ items: [] }),
    ...extra,
  })
}

async function ask(text: string) {
  await userEvent.type(await screen.findByRole('textbox', { name: 'Pergunta' }), text)
  await userEvent.click(screen.getByRole('button', { name: 'Enviar' }))
}

describe('Agente', () => {
  it('abre a conversa nova com exemplos e as conversas recentes ao lado', async () => {
    mockAgent()
    renderApp('/agente')
    expect(await screen.findByRole('heading', { level: 1, name: 'Nova conversa' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Quais decisões foram tomadas/ })).toBeInTheDocument()
    const recent = screen.getByRole('navigation', { name: 'Conversas recentes' })
    expect(await within(recent).findByRole('link', { name: 'Conversa sem título' })).toHaveAttribute(
      'href',
      `/agente/${SESSION}`,
    )
    expect(within(recent).getByRole('link', { name: 'Todas as conversas' })).toHaveAttribute('href', '/agente/conversas')
  })

  it('a rota antiga /perguntas leva ao Agente', async () => {
    mockAgent()
    renderApp('/perguntas')
    expect(await screen.findByRole('heading', { level: 1, name: 'Nova conversa' })).toBeInTheDocument()
  })

  it('a primeira pergunta abre a conversa, espera a resposta e mostra o arquivo gerado e as fontes', async () => {
    const running = { ...fixtures.agentTurn().answer, status: 'running' as const }
    let polls = 0
    const http = mockAgent({
      'GET /api/v1/agent/sessions/:id/messages/:mid': () => (polls++ === 0 ? running : fixtures.agentMessageDone()),
    })
    renderApp('/agente')
    await ask('Liste os prazos da ata e do kickoff numa tabela.')

    await waitFor(() => expect(http.requests('POST /api/v1/agent/sessions')).toHaveLength(1))
    expect(await http.requests('POST /api/v1/agent/sessions/:id/messages')[0].json()).toEqual({
      message: 'Liste os prazos da ata e do kickoff numa tabela.',
      attachments: [],
    })
    const log = await screen.findByRole('log', { name: 'Conversa' })
    expect(await within(log).findByText('Liste os prazos da ata e do kickoff numa tabela.')).toBeInTheDocument()

    await advance(AGENT_POLL_MS)
    await advance(AGENT_POLL_MS)
    expect(await within(log).findByText(/Preparei a tabela/)).toBeInTheDocument()
    const generated = within(log).getByRole('list', { name: 'Arquivos gerados' })
    const link = within(generated).getByRole('link', { name: 'prazos.csv' })
    expect(link).toHaveAttribute('href', '/api/v1/agent/files/01928f3a-1c00-7a00-8000-000000000a12/content')
    expect(link).toHaveAttribute('download', 'prazos.csv')
    const sources = within(log).getByRole('list', { name: 'Fontes' })
    expect(within(sources).getByRole('link', { name: 'Kickoff Serra Azul' })).toHaveAttribute(
      'href',
      '/gravacoes/01928f3a-1c00-7a00-8000-000000000201',
    )
    expect(within(log).getByText('Fez 3 consultas')).toBeInTheDocument()
  })

  it('retoma uma conversa guardada com o histórico e os anexos', async () => {
    mockAgent({ 'GET /api/v1/agent/sessions/:id': () => fixtures.agentSessionDetail() })
    renderApp(`/agente/${SESSION}`)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Liste os prazos da ata e do kickoff numa tabela.' }),
    ).toBeInTheDocument()
    const log = screen.getByRole('log', { name: 'Conversa' })
    const attached = within(log).getByRole('list', { name: 'Anexos' })
    expect(within(attached).getByRole('link', { name: 'ata-kickoff.pdf' })).toBeInTheDocument()
    expect(await within(log).findByRole('link', { name: 'prazos.csv' })).toBeInTheDocument()
  })

  it('anexa um arquivo, mostra antes de enviar e o manda junto com a pergunta', async () => {
    const http = mockAgent()
    renderApp(`/agente/${SESSION}`)
    const picker = await screen.findByLabelText('Arquivos para anexar')
    await userEvent.upload(picker, new File(['%PDF-1.4'], 'ata-kickoff.pdf', { type: 'application/pdf' }))

    const next = await screen.findByRole('list', { name: 'Anexos da próxima pergunta' })
    expect(within(next).getByRole('link', { name: 'ata-kickoff.pdf' })).toBeInTheDocument()
    const form = http.requests('POST /api/v1/agent/sessions/:id/files')[0]
    // O FormData relido pelo mock vem de outro realm (o File do Node, não o do jsdom): confere o conteúdo.
    expect((await form.formData()).get('file')).toMatchObject({ size: 8, type: 'application/pdf' })

    await ask('Resuma a ata')
    await waitFor(() => expect(http.requests('POST /api/v1/agent/sessions/:id/messages')).toHaveLength(1))
    expect(await http.requests('POST /api/v1/agent/sessions/:id/messages')[0].json()).toEqual({
      message: 'Resuma a ata',
      attachments: ['01928f3a-1c00-7a00-8000-000000000a11'],
    })
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Anexos da próxima pergunta' })).not.toBeInTheDocument())
  })

  it('tira um anexo antes de enviar', async () => {
    const http = mockAgent({
      'GET /api/v1/agent/sessions/:id': () => ({ ...emptyDetail(), pending_files: [fixtures.agentFileInput()] }),
    })
    renderApp(`/agente/${SESSION}`)
    await userEvent.click(await screen.findByRole('button', { name: 'Tirar ata-kickoff.pdf' }))
    await waitFor(() => expect(http.requests('DELETE /api/v1/agent/sessions/:id/files/:fid')).toHaveLength(1))
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Anexos da próxima pergunta' })).not.toBeInTheDocument())
  })

  it('recusa arquivo grande demais sem enviar', async () => {
    const http = mockAgent()
    renderApp(`/agente/${SESSION}`)
    const big = new File(['x'], 'enorme.pdf', { type: 'application/pdf' })
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 })
    await userEvent.upload(await screen.findByLabelText('Arquivos para anexar'), big)
    expect(await screen.findByRole('alert')).toHaveTextContent('enorme.pdf passa de 10 MB.')
    expect(http.requests('POST /api/v1/agent/sessions/:id/files')).toHaveLength(0)
  })

  it('mostra a recusa do tipo de arquivo pelo servidor', async () => {
    mockAgent({
      'POST /api/v1/agent/sessions/:id/files': () =>
        problem('unsupported_media_type', 415, { detail: 'Tipo não aceito. Anexe .txt, .md, .csv, .pdf, .docx.' }),
    })
    renderApp(`/agente/${SESSION}`)
    // O `accept` do campo filtraria um .png antes do envio: a recusa aqui é a do servidor.
    await userEvent.upload(
      await screen.findByLabelText('Arquivos para anexar'),
      new File(['x'], 'foto.pdf', { type: 'application/pdf' }),
    )
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('explica a falta de modelo e deixa tentar de novo', async () => {
    const failed = {
      ...fixtures.agentTurn().answer,
      status: 'failed' as const,
      error: { code: 'no_provider', message: 'Nenhum provider habilitado para o chat.' },
    }
    const http = mockAgent({ 'GET /api/v1/agent/sessions/:id/messages/:mid': () => failed })
    renderApp(`/agente/${SESSION}`)
    await ask('Algo?')
    expect(await screen.findByText(/ainda não tem um modelo configurado/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await waitFor(() => expect(http.requests('POST /api/v1/agent/sessions/:id/messages')).toHaveLength(2))
  })

  it('mostra o limite de perguntas em aberto', async () => {
    mockAgent({
      'POST /api/v1/agent/sessions/:id/messages': () =>
        problem('rate_limited', 429, { detail: 'Já há 2 perguntas em andamento.' }),
    })
    renderApp(`/agente/${SESSION}`)
    await ask('Muitas')
    expect(await screen.findByRole('alert')).toHaveTextContent(/Muitas requisições seguidas/)
  })

  it('avisa quando a conversa não existe mais', async () => {
    mockAgent({ 'GET /api/v1/agent/sessions/:id': () => problem('not_found', 404) })
    renderApp(`/agente/${SESSION}`)
    expect(await screen.findByText(/Esta conversa não existe mais/)).toBeInTheDocument()
  })

  it('escolhe a habilidade no seletor e mostra o nome dela na pergunta', async () => {
    const skill = {
      id: '01928f3a-1c00-7a00-8000-000000000b01',
      name: 'ata',
      description: 'Escreve a ata.',
      instructions: 'Decisões e prazos.',
      allowed_tools: null,
      enabled: true,
      created_at: '2026-10-05T13:00:00Z',
      updated_at: '2026-10-05T13:00:00Z',
    }
    const turn = fixtures.agentTurn()
    const http = mockAgent({
      'GET /api/v1/agent/skills': () => ({ items: [skill, { ...skill, id: 'off', name: 'rascunho', enabled: false }] }),
      'POST /api/v1/agent/sessions/:id/messages': () => ({ ...turn, question: { ...turn.question, skill: 'ata' } }),
    })
    renderApp(`/agente/${SESSION}`)
    const picker = await screen.findByRole('combobox', { name: 'Habilidade' })
    expect(within(picker).queryByRole('option', { name: '/rascunho' })).not.toBeInTheDocument()
    await userEvent.selectOptions(picker, '/ata')
    await ask('Faça a ata do kickoff')
    await waitFor(() => expect(http.requests('POST /api/v1/agent/sessions/:id/messages')).toHaveLength(1))
    expect(await http.requests('POST /api/v1/agent/sessions/:id/messages')[0].json()).toEqual({
      message: 'Faça a ata do kickoff',
      attachments: [],
      skill: 'ata',
    })
    const log = screen.getByRole('log', { name: 'Conversa' })
    expect(await within(log).findByText('/ata')).toBeInTheDocument()
  })

  it('com /nome digitado, o texto vai como está e o seletor não manda habilidade', async () => {
    const http = mockAgent()
    renderApp(`/agente/${SESSION}`)
    await ask('/ata do kickoff')
    await waitFor(() => expect(http.requests('POST /api/v1/agent/sessions/:id/messages')).toHaveLength(1))
    expect(await http.requests('POST /api/v1/agent/sessions/:id/messages')[0].json()).toEqual({
      message: '/ata do kickoff',
      attachments: [],
    })
  })

  it('mostra o cartão da ação proposta e confirma', async () => {
    const proposed = fixtures.agentActionProposed()
    const answer = { ...fixtures.agentMessageDone(), actions: [proposed] }
    const done = {
      ...proposed,
      status: 'done',
      counts: { done: 2, skipped: 0, failed: 0, pending: 0 },
      targets: proposed.targets.map((target) => ({ ...target, result: { status: 'done' } })),
    }
    const http = mockAgent({
      'GET /api/v1/agent/sessions/:id': () => ({ ...emptyDetail(), messages: [answer] }),
      'POST /api/v1/agent/actions/:id/confirm': () => ({ ...proposed, status: 'queued' }),
      'GET /api/v1/agent/actions/:id': () => done,
    })
    renderApp(`/agente/${SESSION}`)
    const card = await screen.findByRole('region', { name: 'Ação proposta' })
    expect(card).toHaveTextContent('Nas tags de 2 gravações: aplicar "auditoria".')
    expect(card).toHaveTextContent('Aguardando a sua confirmação')
    const targets = within(card).getByRole('list', { name: 'Gravações afetadas' })
    expect(within(targets).getByRole('link', { name: 'Kickoff Aurora' })).toHaveAttribute(
      'href',
      `/gravacoes/${proposed.targets[0].recording_id}`,
    )
    expect(http.requests('POST /api/v1/agent/actions/:id/confirm')).toHaveLength(0)

    await userEvent.click(within(card).getByRole('button', { name: 'Confirmar' }))
    await waitFor(() => expect(http.requests('POST /api/v1/agent/actions/:id/confirm')).toHaveLength(1))
    await advance(AGENT_POLL_MS)
    expect(await within(card).findByText(/Concluída · 2 feita\(s\)/)).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument()
  })

  it('descarta a proposta sem executar', async () => {
    const proposed = fixtures.agentActionProposed()
    const answer = { ...fixtures.agentMessageDone(), actions: [proposed] }
    const http = mockAgent({
      'GET /api/v1/agent/sessions/:id': () => ({ ...emptyDetail(), messages: [answer] }),
      'POST /api/v1/agent/actions/:id/cancel': () => ({ ...proposed, status: 'cancelled' }),
    })
    renderApp(`/agente/${SESSION}`)
    const card = await screen.findByRole('region', { name: 'Ação proposta' })
    await userEvent.click(within(card).getByRole('button', { name: 'Descartar' }))
    expect(await within(card).findByText('Descartada')).toBeInTheDocument()
    expect(http.requests('POST /api/v1/agent/actions/:id/confirm')).toHaveLength(0)
  })
})
