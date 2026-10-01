import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, json, mockFetch } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/admin/agentes', '/admin/segredos'))

afterEach(() => vi.unstubAllGlobals())

function mockAgentsApi(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/admin/me': () => fixtures.adminMe(),
    'GET /api/v1/privacy': () => fixtures.privacyInfo(),
    'GET /api/v1/admin/agent-providers': () => fixtures.agentProviderPage(),
    'GET /api/v1/admin/secrets': () => fixtures.secretList(),
    ...extra,
  })
}

const bodyOf = (http: ReturnType<typeof mockFetch>, key: string, index = 0) => http.requests(key)[index].json()

function row(name: string) {
  return screen.getByText(name, { selector: '.list-row-title' }).closest('.list-row') as HTMLElement
}

describe('Agentes', () => {
  it('lista os providers com o tipo, o endereço e as finalidades', async () => {
    mockAgentsApi()
    renderApp('/admin/agentes')
    expect(await screen.findByText('Claude (servidor)')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Agentes' })).toBeInTheDocument()
    const claude = row('Claude (servidor)')
    expect(within(claude).getByText('Claude Code do servidor · resumos, preenchimento de campos, chat do resumo')).toBeInTheDocument()
    expect(within(claude).getByText('Habilitado')).toBeInTheDocument()
    // O claude-cli sem token guardado.
    expect(within(claude).getByText('Sem token')).toHaveClass('badge-warning')
    const deepseek = row('DeepSeek')
    expect(
      within(deepseek).getByText('OpenAI-compatível · https://api.deepseek.com/v1 · detecção do tipo de agenda'),
    ).toBeInTheDocument()
    expect(within(deepseek).queryByText('Sem chave')).not.toBeInTheDocument()
    // Todas as finalidades têm dono habilitado: sem aviso.
    expect(screen.queryByText(/Sem provider para/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Provider padrão')).not.toBeInTheDocument()
  })

  it('avisa as finalidades sem provider habilitado e o "sem uso"', async () => {
    const page = fixtures.agentProviderPage()
    page.items[1].enabled = false
    page.items[0].used_for = []
    mockAgentsApi({ 'GET /api/v1/admin/agent-providers': () => page })
    renderApp('/admin/agentes')
    expect(
      await screen.findByText(
        'Sem provider para: resumos, preenchimento de campos, chat do resumo, detecção do tipo de agenda.',
      ),
    ).toBeInTheDocument()
    expect(within(row('Claude (servidor)')).getByText(/· sem uso$/)).toBeInTheDocument()
    expect(within(row('DeepSeek')).getByText('Desligado')).toBeInTheDocument()
  })

  it('o anthropic sem chave própria só pede chave quando a compartilhada falta', async () => {
    const page = fixtures.agentProviderPage()
    page.items.push({ ...page.items[1], id: 'a1', name: 'Sonnet', kind: 'anthropic', base_url: null, api_key_set: false })
    const secrets = fixtures.secretList()
    mockAgentsApi({ 'GET /api/v1/admin/agent-providers': () => page, 'GET /api/v1/admin/secrets': () => secrets })
    const { unmount } = renderApp('/admin/agentes')
    await screen.findByRole('group', { name: 'Chave da API da Anthropic' })
    expect(within(row('Sonnet')).getByText('Sem chave')).toBeInTheDocument()
    unmount()

    secrets.items[1].is_set = true
    renderApp('/admin/agentes')
    await screen.findByText('•••••••• guardado')
    expect(within(row('Sonnet')).queryByText('Sem chave')).not.toBeInTheDocument()
  })

  it('cadastra com endereço, finalidades livres marcadas e a chave no POST', async () => {
    const page = fixtures.agentProviderPage()
    page.items[1].used_for = []
    const http = mockAgentsApi({
      'GET /api/v1/admin/agent-providers': () => page,
      'POST /api/v1/admin/agent-providers': () => json(page.items[1], 201),
    })
    renderApp('/admin/agentes')
    await userEvent.click(await screen.findByRole('button', { name: 'Cadastrar provider' }))
    const form = screen.getByRole('form', { name: 'Novo provider' })
    await userEvent.type(within(form).getByLabelText('Nome'), 'Groq')
    await userEvent.selectOptions(within(form).getByLabelText('Tipo'), 'openai-compatible')
    await userEvent.type(within(form).getByLabelText('Modelo'), 'llama-3.3-70b')
    await userEvent.type(within(form).getByLabelText('Endereço da API'), 'https://api.groq.com/openai/v1')
    await userEvent.type(within(form).getByLabelText('Chave de API'), 'gsk_segredo')
    // A detecção estava sem dono: vem marcada. As outras são do Claude.
    const detection = within(form).getByRole('checkbox', { name: /Detecção do tipo de agenda/ })
    expect(detection).toBeChecked()
    const summaries = within(form).getByRole('checkbox', { name: /Resumos/ })
    expect(summaries).not.toBeChecked()
    expect(summaries.closest('label')).toHaveTextContent('Resumos · hoje com Claude (servidor)')
    expect(detection.closest('label')).toHaveTextContent(/^Detecção do tipo de agenda$/)
    await userEvent.click(summaries)
    await userEvent.click(within(form).getByRole('button', { name: 'Salvar' }))
    expect(await bodyOf(http, 'POST /api/v1/admin/agent-providers')).toEqual({
      name: 'Groq',
      kind: 'openai-compatible',
      model: 'llama-3.3-70b',
      base_url: 'https://api.groq.com/openai/v1',
      enabled: true,
      used_for: ['agenda_detection', 'summaries'],
      api_key: 'gsk_segredo',
    })
    await vi.waitFor(() => expect(screen.queryByRole('form', { name: 'Novo provider' })).not.toBeInTheDocument())
  })

  it('o claude-cli pede o token do claude setup-token, os outros a chave de API', async () => {
    mockAgentsApi()
    renderApp('/admin/agentes')
    await userEvent.click(await screen.findByRole('button', { name: 'Cadastrar provider' }))
    const form = screen.getByRole('form', { name: 'Novo provider' })
    // O tipo que vem escolhido não é a CLI proprietária.
    expect(within(form).getByLabelText('Tipo')).toHaveValue('ollama')
    await userEvent.selectOptions(within(form).getByLabelText('Tipo'), 'claude-cli')
    expect(within(form).getByText(/exige a imagem construída com a CLI/)).toBeInTheDocument()
    expect(within(form).getByLabelText('Token do Claude')).toHaveAccessibleDescription(/claude setup-token/)
    expect(within(form).queryByLabelText('Chave de API')).not.toBeInTheDocument()
    await userEvent.selectOptions(within(form).getByLabelText('Tipo'), 'anthropic')
    expect(within(form).getByLabelText('Chave de API')).toBeInTheDocument()
    expect(within(form).queryByLabelText('Endereço da API')).not.toBeInTheDocument()
  })

  it('edita: tipo fixo, finalidades, token substituído e apagado na hora', async () => {
    const http = mockAgentsApi({
      'PATCH /api/v1/admin/agent-providers/:id': () => fixtures.agentProviderPage().items[1],
    })
    renderApp('/admin/agentes')
    await userEvent.click(await screen.findByRole('button', { name: 'Editar DeepSeek' }))
    const form = screen.getByRole('form', { name: 'Editar DeepSeek' })
    expect(within(form).getByRole('heading', { level: 4, name: 'DeepSeek' })).toBeInTheDocument()
    expect(within(form).getByLabelText('Tipo')).toHaveAttribute('readonly')
    expect(within(form).getByLabelText('Tipo')).toHaveValue('OpenAI-compatível')

    const key = within(form).getByRole('group', { name: 'Chave de API' })
    expect(within(key).getByText('•••••••• guardado')).toBeInTheDocument()
    await userEvent.click(within(key).getByRole('button', { name: 'Substituir' }))
    await userEvent.type(within(key).getByLabelText('Chave de API'), 'sk-novo{Enter}')
    await vi.waitFor(() => expect(http.requests('PATCH /api/v1/admin/agent-providers/:id')).toHaveLength(1))
    expect(await bodyOf(http, 'PATCH /api/v1/admin/agent-providers/:id')).toEqual({ api_key: 'sk-novo' })

    await userEvent.click(await within(key).findByRole('button', { name: 'Apagar' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apagar' }))
    await vi.waitFor(() => expect(http.requests('PATCH /api/v1/admin/agent-providers/:id')).toHaveLength(2))
    expect(await bodyOf(http, 'PATCH /api/v1/admin/agent-providers/:id', 1)).toEqual({ api_key: null })

    await userEvent.click(within(form).getByRole('checkbox', { name: /Chat do resumo/ }))
    await userEvent.click(within(form).getByRole('switch', { name: 'Habilitado' }))
    await userEvent.click(within(form).getByRole('button', { name: 'Salvar' }))
    await vi.waitFor(() => expect(http.requests('PATCH /api/v1/admin/agent-providers/:id')).toHaveLength(3))
    expect(await bodyOf(http, 'PATCH /api/v1/admin/agent-providers/:id', 2)).toEqual({
      name: 'DeepSeek',
      model: 'deepseek-chat',
      base_url: 'https://api.deepseek.com/v1',
      enabled: false,
      used_for: ['agenda_detection', 'chat'],
    })
  })

  it('exclui o provider depois de confirmar', async () => {
    const http = mockAgentsApi({ 'DELETE /api/v1/admin/agent-providers/:id': () => empty(204) })
    renderApp('/admin/agentes')
    await userEvent.click(await screen.findByRole('button', { name: 'Editar DeepSeek' }))
    await userEvent.click(screen.getByRole('button', { name: 'Excluir provider' }))
    const dialog = await screen.findByRole('dialog', { name: 'Excluir DeepSeek?' })
    expect(dialog).toHaveTextContent('Os resumos já gerados continuam.')
    expect(http.requests('DELETE /api/v1/admin/agent-providers/:id')).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }))
    await vi.waitFor(() => expect(http.requests('DELETE /api/v1/admin/agent-providers/:id')).toHaveLength(1))
    expect(new URL(http.requests('DELETE /api/v1/admin/agent-providers/:id')[0].url).pathname).toBe(
      '/api/v1/admin/agent-providers/01928f3a-1c00-7a00-8000-000000000b02',
    )
  })

  it('grava a chave compartilhada da Anthropic sem mostrar o valor', async () => {
    const http = mockAgentsApi({ 'PUT /api/v1/admin/secrets/:name': () => empty(204) })
    renderApp('/admin/agentes')
    const shared = await screen.findByRole('group', { name: 'Chave da API da Anthropic' })
    expect(shared).toHaveTextContent('Usada pelos providers “API da Anthropic” cadastrados sem chave própria.')
    const input = within(shared).getByLabelText('Chave da API da Anthropic')
    expect(input).toHaveAttribute('type', 'password')
    await userEvent.type(input, 'sk-ant-segredo')
    await userEvent.click(within(shared).getByRole('button', { name: 'Salvar' }))
    await vi.waitFor(() => expect(http.requests('PUT /api/v1/admin/secrets/:name')).toHaveLength(1))
    const put = http.requests('PUT /api/v1/admin/secrets/:name')[0]
    expect(new URL(put.url).pathname).toBe('/api/v1/admin/secrets/anthropic_api_key')
    expect(await put.json()).toEqual({ value: 'sk-ant-segredo' })
    expect(screen.queryByText('sk-ant-segredo')).not.toBeInTheDocument()
  })

  it('/admin/segredos leva a Locutores', async () => {
    mockAgentsApi({ 'GET /api/v1/admin/settings': () => fixtures.adminSettings() })
    renderApp('/admin/segredos')
    expect(await screen.findByRole('heading', { level: 1, name: 'Locutores' })).toBeInTheDocument()
  })

  it('avisa as finalidades que mandam dados para fora do servidor', async () => {
    mockAgentsApi()
    renderApp('/admin/agentes')
    const note = await screen.findByRole('note', { name: 'Dados fora do servidor' })
    expect(note).toHaveTextContent('resumos (Anthropic), chat (Anthropic)')
    expect(note).toHaveTextContent('Conta › Privacidade e dados')
    expect(note).not.toHaveTextContent('campos')
  })
})
