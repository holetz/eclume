import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
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
