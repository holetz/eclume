import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, json, mockFetch, problem } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => vi.unstubAllGlobals())

const MEMBER_ID = '01928f3a-1c00-7a00-8000-000000000102'

function mockAdminApi(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/admin/settings': () => fixtures.adminSettings(),
    'GET /api/v1/admin/agent-providers': () => fixtures.agentProviderPage(),
    'GET /api/v1/summary-templates': () => fixtures.summaryTemplatePage(),
    'GET /api/v1/admin/secrets': () => fixtures.secretList(),
    'GET /api/v1/admin/users': () => fixtures.userPage(),
    'GET /api/v1/admin/invitations': () => ({ items: [fixtures.invitation()], next_cursor: null }),
    'GET /api/v1/groups': () => fixtures.groupPage(),
    'GET /api/v1/admin/health': () => fixtures.adminHealth(),
    ...extra,
  })
}

async function body(http: ReturnType<typeof mockFetch>, key: string, index = 0) {
  return http.requests(key)[index].json()
}

describe('guarda e navegação', () => {
  it('membro não entra na área', async () => {
    const me = fixtures.me()
    me.user.role = 'member'
    mockAdminApi({ 'GET /api/v1/me': () => me })
    renderApp('/admin/usuarios')
    expect(await screen.findByRole('heading', { name: 'Sem permissão' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Seções da administração' })).not.toBeInTheDocument()
  })

  it('admin cai em Transcrição e navega pelas seções', async () => {
    mockAdminApi()
    renderApp('/admin')
    expect(await screen.findByRole('heading', { name: 'Transcrição' })).toBeInTheDocument()
    const tabs = screen.getByRole('navigation', { name: 'Seções da administração' })
    expect(within(tabs).getByRole('link', { name: 'Transcrição' })).toHaveAttribute('aria-current', 'page')
    await userEvent.click(within(tabs).getByRole('link', { name: 'Saúde' }))
    expect(await screen.findByRole('heading', { name: 'Saúde' })).toBeInTheDocument()
    const main = screen.getByRole('navigation', { name: 'Principal' })
    expect(within(main).getByRole('link', { name: 'Painel admin' })).toHaveAttribute('aria-current', 'page')
  })
})

describe('Transcrição', () => {
  it('mostra a configuração e salva o que mudou', async () => {
    const http = mockAdminApi({
      'PATCH /api/v1/admin/settings': () => ({ ...fixtures.adminSettings(), updated_at: '2026-09-25T12:00:00Z' }),
    })
    renderApp('/admin/transcricao')
    const model = await screen.findByLabelText('Modelo')
    expect(model).toHaveValue('large-v3-turbo')
    expect(screen.getByLabelText('Tipo de computação')).toHaveValue('int8_float16')
    expect(within(screen.getByLabelText('Tipo de computação')).queryByText(/^float16/)).not.toBeInTheDocument()
    expect(screen.getByText(/Última alteração por Mariana Couto/)).toBeInTheDocument()

    await userEvent.clear(model)
    await userEvent.type(model, 'large-v3')
    await userEvent.type(screen.getByLabelText('Máximo de locutores'), '4')
    await userEvent.click(screen.getByRole('checkbox', { name: /Resumir automaticamente/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Salvar configuração' }))
    expect(await screen.findByText('Configuração salva.')).toBeInTheDocument()

    const sent = await body(http, 'PATCH /api/v1/admin/settings')
    expect(sent.asr).toMatchObject({ engine: 'whisperx-local', model: 'large-v3', batch_size: null, default_language: 'pt' })
    expect(sent.diarization).toEqual({ enabled: true, min_speakers: null, max_speakers: 4 })
    expect(sent.summarization).toEqual({ auto_summarize: true })
  })

  it('pede o endereço para o motor remoto e mostra o erro do servidor', async () => {
    mockAdminApi({
      'PATCH /api/v1/admin/settings': () =>
        problem('validation_failed', 422, { errors: [{ field: 'asr.endpoint_url', message: 'obrigatória' }] }),
    })
    renderApp('/admin/transcricao')
    await userEvent.selectOptions(await screen.findByLabelText('Motor'), 'openai-compatible')
    const save = screen.getByRole('button', { name: 'Salvar configuração' })
    expect(save).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Endereço do servidor remoto'), 'http://speaches:8000/v1')
    await userEvent.click(save)
    expect(await screen.findByRole('alert')).toHaveTextContent('asr.endpoint_url: obrigatória')
  })
})

describe('Agentes', () => {
  it('lista os providers e troca o padrão', async () => {
    const http = mockAdminApi({ 'PATCH /api/v1/admin/settings': () => fixtures.adminSettings() })
    renderApp('/admin/agentes')
    const table = await screen.findByRole('table')
    expect(within(table).getByRole('rowheader', { name: /DeepSeek/ })).toBeInTheDocument()
    expect(within(table).getAllByText('Guardada').length).toBeGreaterThan(0)
    const select = screen.getByLabelText('Provider padrão')
    expect(select).toHaveValue('01928f3a-1c00-7a00-8000-000000000b01')
    await userEvent.selectOptions(select, '01928f3a-1c00-7a00-8000-000000000b02')
    expect(await body(http, 'PATCH /api/v1/admin/settings')).toEqual({
      summarization: { default_provider_id: '01928f3a-1c00-7a00-8000-000000000b02' },
    })
  })

  it('cadastra com endereço e edita apagando a chave', async () => {
    const provider = fixtures.agentProviderPage().items[1]
    const http = mockAdminApi({
      'POST /api/v1/admin/agent-providers': () => json(provider, 201),
      'PATCH /api/v1/admin/agent-providers/:id': () => provider,
    })
    renderApp('/admin/agentes')
    await userEvent.click(await screen.findByRole('button', { name: 'Cadastrar provider' }))
    const form = screen.getByRole('form', { name: 'Novo provider' })
    await userEvent.type(within(form).getByLabelText('Nome'), 'Groq')
    await userEvent.selectOptions(within(form).getByLabelText('Tipo'), 'openai-compatible')
    await userEvent.type(within(form).getByLabelText('Modelo'), 'llama-3.3-70b')
    await userEvent.type(within(form).getByLabelText('Endereço da API'), 'https://api.groq.com/openai/v1')
    await userEvent.type(within(form).getByLabelText('Chave de API'), 'gsk_segredo')
    await userEvent.click(within(form).getByRole('button', { name: 'Cadastrar' }))
    expect(await body(http, 'POST /api/v1/admin/agent-providers')).toEqual({
      name: 'Groq',
      kind: 'openai-compatible',
      model: 'llama-3.3-70b',
      base_url: 'https://api.groq.com/openai/v1',
      enabled: true,
      api_key: 'gsk_segredo',
    })

    await userEvent.click(await screen.findByRole('button', { name: 'Editar DeepSeek' }))
    const edit = screen.getByRole('form', { name: 'Editar “DeepSeek”' })
    expect(within(edit).getByLabelText('Tipo')).toBeDisabled()
    await userEvent.click(within(edit).getByRole('checkbox', { name: 'Apagar a chave guardada' }))
    await userEvent.click(within(edit).getByRole('button', { name: 'Salvar alterações' }))
    const patch = await body(http, 'PATCH /api/v1/admin/agent-providers/:id')
    expect(patch.api_key).toBeNull()
  })
})

describe('Templates padrão', () => {
  it('mostra só os da organização e troca o padrão', async () => {
    const page = fixtures.summaryTemplatePage()
    const other = { ...page.items[0], id: '01928f3a-1c00-7a00-8000-000000000903', name: 'Decisões e ações', is_default: false }
    page.items.push(other)
    const http = mockAdminApi({
      'GET /api/v1/summary-templates': () => page,
      'PATCH /api/v1/summary-templates/:id': () => ({ ...other, is_default: true }),
    })
    renderApp('/admin/templates')
    expect(await screen.findByRole('listitem', { name: 'Ata de reunião' })).toHaveTextContent('Padrão da organização')
    expect(screen.queryByRole('listitem', { name: 'Resumo executivo' })).not.toBeInTheDocument()
    const item = screen.getByRole('listitem', { name: 'Decisões e ações' })
    await userEvent.click(within(item).getByRole('button', { name: 'Tornar padrão' }))
    await vi.waitFor(() => expect(http.requests('PATCH /api/v1/summary-templates/:id')).toHaveLength(1))
    const request = http.requests('PATCH /api/v1/summary-templates/:id')[0]
    expect(new URL(request.url).pathname).toBe(`/api/v1/summary-templates/${other.id}`)
    expect(await request.json()).toEqual({ is_default: true })
  })

  it('cria um template da organização', async () => {
    const http = mockAdminApi({
      'POST /api/v1/summary-templates': () => json(fixtures.summaryTemplatePage().items[0], 201),
    })
    renderApp('/admin/templates')
    await userEvent.click(await screen.findByRole('button', { name: 'Novo template da organização' }))
    const form = screen.getByRole('form', { name: 'Novo template da organização' })
    await userEvent.type(within(form).getByLabelText('Nome'), 'Pauta da próxima')
    await userEvent.type(within(form).getByLabelText('Instruções ao agente'), 'Liste os pontos pendentes.')
    await userEvent.click(within(form).getByRole('button', { name: 'Criar template' }))
    expect(await body(http, 'POST /api/v1/summary-templates')).toEqual({
      name: 'Pauta da próxima',
      description: null,
      instructions: 'Liste os pontos pendentes.',
      scope: 'organization',
    })
  })
})

describe('Usuários e convites', () => {
  it('muda papel, desativa só depois de confirmar e não oferece desativar a si mesmo', async () => {
    const member = fixtures.userPage().items[1]
    const http = mockAdminApi({ 'PATCH /api/v1/admin/users/:id': () => ({ ...member, active: false }) })
    renderApp('/admin/usuarios')
    const selfRow = await screen.findByRole('row', { name: /Mariana Couto \(você\)/ })
    const table = selfRow.closest('table')!
    expect(within(selfRow).queryByRole('button', { name: /Desativar/ })).not.toBeInTheDocument()

    await userEvent.click(within(table).getByRole('button', { name: 'Desativar Paulo Andrade' }))
    expect(http.requests('PATCH /api/v1/admin/users/:id')).toHaveLength(0)
    await userEvent.click(within(table).getByRole('button', { name: 'Confirmar desativação' }))
    expect(await within(table).findByText('Desativado')).toBeInTheDocument()
    const request = http.requests('PATCH /api/v1/admin/users/:id')[0]
    expect(new URL(request.url).pathname).toBe(`/api/v1/admin/users/${MEMBER_ID}`)
    expect(await request.json()).toEqual({ active: false })
    expect(within(table).getByRole('button', { name: 'Reativar Paulo Andrade' })).toBeInTheDocument()
  })

  it('convida com grupos e mostra o link uma vez', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const http = mockAdminApi({ 'POST /api/v1/admin/invitations': () => json(fixtures.invitation(), 201) })
    renderApp('/admin/usuarios')
    const form = await screen.findByRole('form', { name: 'Novo convite' })
    await userEvent.type(within(form).getByLabelText('E-mail'), 'beatriz.nunes@example.com')
    await userEvent.click(await within(form).findByRole('checkbox', { name: 'Consultores' }))
    await userEvent.selectOptions(within(form).getByLabelText('Validade do link'), '14')
    await userEvent.click(within(form).getByRole('button', { name: 'Criar convite' }))

    const panel = await screen.findByRole('region', { name: /Convite para beatriz.nunes@example.com criado/ })
    const link = 'https://192.168.15.199:8443/convite/Zk3qW8rT5yU1iO7pA2sD'
    expect(within(panel).getByLabelText('Link do convite')).toHaveValue(link)
    await userEvent.click(within(panel).getByRole('button', { name: 'Copiar' }))
    expect(writeText).toHaveBeenCalledWith(link)
    expect(await body(http, 'POST /api/v1/admin/invitations')).toEqual({
      email: 'beatriz.nunes@example.com',
      role: 'member',
      group_ids: ['01928f3a-1c00-7a00-8000-000000000201'],
      expires_in_days: 14,
    })
    await userEvent.click(within(panel).getByRole('button', { name: 'Pronto, já enviei' }))
    expect(screen.queryByDisplayValue(link)).not.toBeInTheDocument()
  })

  it('lista os convites e revoga o pendente', async () => {
    const http = mockAdminApi({ 'DELETE /api/v1/admin/invitations/:id': () => empty(204) })
    renderApp('/admin/usuarios')
    const row = await screen.findByRole('row', { name: /beatriz.nunes@example.com/ })
    expect(within(row).getByText('Pendente')).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: /Revogar convite/ }))
    expect(await screen.findByText('Nenhum convite criado.')).toBeInTheDocument()
    expect(http.requests('DELETE /api/v1/admin/invitations/:id')).toHaveLength(1)
  })
})

describe('Segredos', () => {
  it('grava sem nunca mostrar o valor e apaga depois de confirmar', async () => {
    const http = mockAdminApi({
      'PUT /api/v1/admin/secrets/:name': () => empty(204),
      'DELETE /api/v1/admin/secrets/:name': () => empty(204),
    })
    renderApp('/admin/segredos')
    const hf = await screen.findByRole('form', { name: 'Token do Hugging Face' })
    expect(within(hf).getByText('Definido')).toBeInTheDocument()
    const anthropic = screen.getByRole('form', { name: 'Chave da API da Anthropic' })
    expect(within(anthropic).getByText('Não definido')).toBeInTheDocument()

    const input = within(anthropic).getByLabelText('Valor')
    expect(input).toHaveAttribute('type', 'password')
    await userEvent.type(input, 'sk-ant-segredo')
    await userEvent.click(within(anthropic).getByRole('button', { name: 'Salvar' }))
    expect(await within(anthropic).findByText('Chave da API da Anthropic salvo.')).toBeInTheDocument()
    expect(input).toHaveValue('')
    const put = http.requests('PUT /api/v1/admin/secrets/:name')[0]
    expect(new URL(put.url).pathname).toBe('/api/v1/admin/secrets/anthropic_api_key')
    expect(await put.json()).toEqual({ value: 'sk-ant-segredo' })
    expect(screen.queryByText('sk-ant-segredo')).not.toBeInTheDocument()

    await userEvent.click(within(hf).getByRole('button', { name: 'Apagar Token do Hugging Face' }))
    expect(http.requests('DELETE /api/v1/admin/secrets/:name')).toHaveLength(0)
    await userEvent.click(within(hf).getByRole('button', { name: 'Confirmar exclusão' }))
    expect(await within(hf).findByText('Token do Hugging Face apagado.')).toBeInTheDocument()
  })
})

describe('Saúde', () => {
  it('mostra worker, GPU, modelos, filas e jobs', async () => {
    mockAdminApi()
    renderApp('/admin/saude')
    const gpu = await screen.findByRole('article', { name: 'GPU' })
    expect(within(gpu).getByText('NVIDIA GeForce GTX 1660 SUPER')).toBeInTheDocument()
    expect(within(gpu).getByText(/3\.890 de 6\.144 MiB/)).toBeInTheDocument()
    expect(within(gpu).getByText('large-v3-turbo')).toBeInTheDocument()
    const worker = screen.getByRole('article', { name: 'Worker GPU' })
    expect(within(worker).getByText('No ar')).toBeInTheDocument()
    expect(within(worker).getByText('Transcrevendo')).toBeInTheDocument()
    expect(screen.getByRole('rowheader', { name: /Transcrição \(GPU\)/ })).toBeInTheDocument()
    const job = screen.getByRole('row', { name: /Reunião de alinhamento — cliente Aurora/ })
    expect(within(job).getByText('78%')).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /Entrevista de desligamento/ })).toHaveTextContent('Na fila')
    expect(screen.getByRole('heading', { name: 'Falhas nas últimas 24 horas: 0' })).toBeInTheDocument()
  })

  it('avisa quando o worker está sem sinal e lista as falhas', async () => {
    const health = fixtures.adminHealth()
    health.worker = null
    health.gpu = null
    health.models_loaded = []
    health.queue.failed_last_24h = 1
    health.recent_failures = [
      {
        job_id: '01928f3a-1c00-7a00-8000-000000000e09',
        recording_id: '01928f3a-1c00-7a00-8000-000000000309',
        stage: null,
        code: 'out_of_memory',
        message: 'VRAM insuficiente',
        failed_at: '2026-09-19T12:00:00Z',
      },
    ]
    mockAdminApi({ 'GET /api/v1/admin/health': () => health })
    renderApp('/admin/saude')
    expect(await screen.findByText('Sem sinal')).toBeInTheDocument()
    expect(screen.getByText(/Sem leitura da GPU/)).toBeInTheDocument()
    const failure = screen.getByRole('row', { name: /out_of_memory/ })
    expect(within(failure).getByRole('link', { name: 'Abrir gravação' })).toHaveAttribute(
      'href',
      '/gravacoes/01928f3a-1c00-7a00-8000-000000000309',
    )
  })
})
