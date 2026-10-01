import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkEnvironment, convertAudio, probeMedia, readRecordedAt } from '../lib/media-convert'
import { fixtures } from '../test/fixtures'
import { mockFetch, problem } from '../test/http'
import { preloadRoute, renderApp } from '../test/render'
import { ADMIN_ME_KEY } from '../features/admin/adminSession'
import { ME_KEY } from './session'

beforeAll(() => preloadRoute('/admin/saude'))

vi.mock('../lib/media-convert', async (original) => ({
  ...(await original<typeof import('../lib/media-convert')>()),
  checkEnvironment: vi.fn(),
  convertAudio: vi.fn(),
  probeMedia: vi.fn(),
  readRecordedAt: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(checkEnvironment).mockReturnValue({ secureContext: true, webCodecs: true, subtleCrypto: true })
  vi.mocked(probeMedia).mockResolvedValue({ durationSec: 60, hasAudio: true, estimatedBytes: 1, engine: 'webcodecs' })
  vi.mocked(readRecordedAt).mockResolvedValue({
    at: new Date('2026-09-19T14:02:00Z'),
    source: 'metadata',
    precision: 'minute',
    detail: 'mvhd',
  })
  vi.mocked(convertAudio).mockResolvedValue({ blob: new Blob(['x']), sha256: 'abc', durationSec: 60, engine: 'webcodecs' })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('guarda da sessão', () => {
  it('um 503 no refetch de /me com a sessão carregada mantém o shell e a fila de importação', async () => {
    const user = userEvent.setup()
    let down = false
    mockFetch({
      'GET /api/v1/me': () => (down ? problem('unavailable', 503) : fixtures.me()),
      'GET /api/v1/recordings': () => fixtures.recordingWeekPage(),
      'GET /api/v1/tags': () => fixtures.tagList(),
      'GET /api/v1/collections': () => fixtures.collectionPage(),
      'GET /api/v1/fields': () => fixtures.fieldPage(),
      'GET /api/v1/people': () => fixtures.personPage(),
    })
    const { client } = renderApp('/?visao=semana&data=2026-09-21')
    await user.click(await screen.findByRole('button', { name: 'Importar arquivos' }))
    const dialog = await screen.findByRole('dialog', { name: 'Importar arquivos' })
    await user.upload(
      within(dialog).getByLabelText(/Solte áudio ou vídeo aqui/),
      new File(['a'], 'kickoff.m4a', { type: 'audio/mp4' }),
    )
    await within(dialog).findByText('Pronto para enviar')

    down = true
    await act(() => client.refetchQueries({ queryKey: ME_KEY }))
    await waitFor(() => expect(client.getQueryState(ME_KEY)?.status).toBe('error'))
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Principal' })).toBeInTheDocument()
    expect(within(screen.getByRole('dialog', { name: 'Importar arquivos' })).getByText('Pronto para enviar')).toBeInTheDocument()
  })

  it('sem sessão em cache, a falha de /me mostra o erro com Tentar de novo', async () => {
    mockFetch({ 'GET /api/v1/me': () => problem('unavailable', 503) })
    renderApp('/')
    expect(await screen.findByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Principal' })).not.toBeInTheDocument()
  })

  it('o painel admin também fica de pé num refetch de /admin/me que falha', async () => {
    let down = false
    mockFetch({
      'GET /api/v1/admin/me': () => (down ? problem('unavailable', 503) : fixtures.adminMe()),
      'GET /api/v1/admin/health': () => fixtures.adminHealth(),
    })
    const { client } = renderApp('/admin/saude')
    expect(await screen.findByRole('heading', { level: 1, name: 'Saúde' })).toBeInTheDocument()

    down = true
    await act(() => client.refetchQueries({ queryKey: ADMIN_ME_KEY }))
    await waitFor(() => expect(client.getQueryState(ADMIN_ME_KEY)?.status).toBe('error'))
    expect(screen.getByRole('heading', { level: 1, name: 'Saúde' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).not.toBeInTheDocument()
  })
})
