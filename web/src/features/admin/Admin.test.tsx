import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, json, mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => vi.unstubAllGlobals())

function mockAdminApi(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/admin/me': () => fixtures.adminMe(),
    'GET /api/v1/admin/settings': () => fixtures.adminSettings(),
    'GET /api/v1/admin/agent-providers': () => fixtures.agentProviderPage(),
    'GET /api/v1/admin/secrets': () => fixtures.secretList(),
    'GET /api/v1/admin/users': () => fixtures.adminUserPage(),
    'GET /api/v1/admin/health': () => fixtures.adminHealth(),
    ...extra,
  })
}

async function body(http: ReturnType<typeof mockFetch>, key: string, index = 0) {
  return http.requests(key)[index].json()
}

describe('Agentes', () => {
  it('lista os providers e para que cada um serve', async () => {
    mockAdminApi()
    renderApp('/admin/agentes')
    const table = await screen.findByRole('table')
    expect(within(table).getByRole('rowheader', { name: /DeepSeek/ })).toBeInTheDocument()
    expect(within(table).getAllByText('Guardada').length).toBeGreaterThan(0)
    expect(within(table).getByText('Resumos, Campos, Chat')).toBeInTheDocument()
    expect(within(table).getByText('Detecção do tipo')).toBeInTheDocument()
    expect(screen.queryByLabelText('Provider padrão')).not.toBeInTheDocument()
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

describe('Token do Claude', () => {
  it('o claude-cli pede o token do claude setup-token, os outros a chave de API', async () => {
    const provider = fixtures.agentProviderPage().items[0]
    const http = mockAdminApi({ 'POST /api/v1/admin/agent-providers': () => json(provider, 201) })
    renderApp('/admin/agentes')
    await userEvent.click(await screen.findByRole('button', { name: 'Cadastrar provider' }))
    const form = screen.getByRole('form', { name: 'Novo provider' })
    const token = within(form).getByLabelText('Token do Claude')
    expect(token).toHaveAccessibleDescription(/claude setup-token/)
    expect(within(form).queryByLabelText('Chave de API')).not.toBeInTheDocument()
    await userEvent.type(within(form).getByLabelText('Nome'), 'Claude')
    await userEvent.type(within(form).getByLabelText('Modelo'), 'sonnet')
    await userEvent.type(token, 'sk-ant-oat01-segredo')
    await userEvent.click(within(form).getByRole('button', { name: 'Cadastrar' }))
    expect(await body(http, 'POST /api/v1/admin/agent-providers')).toMatchObject({
      kind: 'claude-cli',
      api_key: 'sk-ant-oat01-segredo',
    })

    await userEvent.click(await screen.findByRole('button', { name: 'Cadastrar provider' }))
    const other = screen.getByRole('form', { name: 'Novo provider' })
    await userEvent.selectOptions(within(other).getByLabelText('Tipo'), 'anthropic')
    expect(within(other).getByLabelText('Chave de API')).toBeInTheDocument()
    expect(within(other).queryByLabelText('Token do Claude')).not.toBeInTheDocument()
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
        retryable: true,
      },
    ]
    const http = mockAdminApi({
      'GET /api/v1/admin/health': () => health,
      'POST /api/v1/admin/jobs/:id/retry': () => ({
        job_id: '01928f3a-1c00-7a00-8000-000000000e10',
        recording_id: '01928f3a-1c00-7a00-8000-000000000309',
        revision: 2,
        state: 'queued',
        queued_at: '2026-09-19T12:05:00Z',
      }),
    })
    renderApp('/admin/saude')
    expect(await screen.findByText('Sem sinal')).toBeInTheDocument()
    expect(screen.getByText(/Sem leitura da GPU/)).toBeInTheDocument()
    const failure = screen.getByRole('row', { name: /out_of_memory/ })
    expect(within(failure).getByRole('link', { name: 'Abrir gravação' })).toHaveAttribute(
      'href',
      '/gravacoes/01928f3a-1c00-7a00-8000-000000000309',
    )
    await userEvent.click(within(failure).getByRole('button', { name: 'Tentar de novo' }))
    expect(await within(failure).findByText('Na fila de novo.')).toBeInTheDocument()
    expect(http.requests('POST /api/v1/admin/jobs/:id/retry')[0].url).toContain(
      '/api/v1/admin/jobs/01928f3a-1c00-7a00-8000-000000000e09/retry',
    )
  })
})
