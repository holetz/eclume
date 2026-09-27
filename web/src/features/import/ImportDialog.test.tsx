import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkEnvironment, convertAudio, probeMedia, readRecordedAt } from '../../lib/media-convert'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'
import { runUpload } from '../../upload/multipart'
import { toLocalInput } from './useImportQueue'

vi.mock('../../lib/media-convert', async (original) => ({
  ...(await original<typeof import('../../lib/media-convert')>()),
  checkEnvironment: vi.fn(),
  convertAudio: vi.fn(),
  probeMedia: vi.fn(),
  readRecordedAt: vi.fn(),
}))
vi.mock('../../upload/multipart', async (original) => ({
  ...(await original<typeof import('../../upload/multipart')>()),
  runUpload: vi.fn(),
  cancelUpload: vi.fn(),
}))

const METADATA = new Date('2026-09-19T14:02:00Z')
const MODIFIED = new Date('2026-09-23T16:00:00Z')

beforeEach(() => {
  vi.mocked(checkEnvironment).mockReturnValue({ secureContext: true, webCodecs: true, subtleCrypto: true })
  vi.mocked(probeMedia).mockResolvedValue({ durationSec: 2832, hasAudio: true, estimatedBytes: 1, engine: 'webcodecs' })
  vi.mocked(readRecordedAt).mockImplementation(async (file) =>
    (file as File).name.endsWith('.mkv')
      ? { at: MODIFIED, source: 'file_date', precision: 'minute', detail: 'lastModified' }
      : { at: METADATA, source: 'metadata', precision: 'minute', detail: 'mvhd' },
  )
  vi.mocked(convertAudio).mockResolvedValue({ blob: new Blob(['x']), sha256: 'abc', durationSec: 2832, engine: 'webcodecs' })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function mockLibrary() {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/recordings': () => fixtures.recordingWeekPage(),
    'GET /api/v1/tags': () => fixtures.tagList(),
    'GET /api/v1/collections': () => fixtures.collectionPage(),
    'GET /api/v1/fields': () => fixtures.fieldPage(),
    'GET /api/v1/people': () => fixtures.personPage(),
  })
}

const files = () => [
  new File(['a'.repeat(2048)], 'kickoff-guion.m4a', { type: 'audio/mp4', lastModified: MODIFIED.getTime() }),
  new File(['b'], 'reuniao-03.mkv', { type: 'video/x-matroska', lastModified: MODIFIED.getTime() }),
]

async function openWithFiles() {
  const user = userEvent.setup()
  const http = mockLibrary()
  renderApp('/?visao=semana&data=2026-09-21')
  await user.click(await screen.findByRole('button', { name: 'Importar arquivos' }))
  const dialog = await screen.findByRole('dialog', { name: 'Importar arquivos' })
  await user.upload(within(dialog).getByLabelText(/Solte áudio ou vídeo aqui/), files())
  await waitFor(() => expect(within(dialog).getAllByText('Pronto para enviar')).toHaveLength(2))
  return { user, http, dialog }
}

describe('modal Importar', () => {
  it('abre sobre a biblioteca, lê a data de cada arquivo e mostra a origem', async () => {
    const { user, dialog } = await openWithFiles()
    expect(within(dialog).getByText('Biblioteca')).toHaveClass('kicker')
    expect(dialog).toHaveClass('dialog', 'dialog-lg')
    expect(dialog.querySelector('label.dropzone')).not.toBeNull()

    const m4a = within(dialog).getByLabelText('Início da gravação de kickoff-guion.m4a')
    expect(m4a).toHaveValue(toLocalInput(METADATA))
    expect(m4a).toHaveAccessibleDescription('Dos metadados do arquivo')
    const mkv = within(dialog).getByLabelText('Início da gravação de reuniao-03.mkv')
    expect(mkv).toHaveAccessibleDescription('Sem data no arquivo · usando a data de modificação, confira')
    expect(mkv).toHaveAttribute('data-warning', 'true')
    expect(within(dialog).getAllByText('47:12')).toHaveLength(2)
    expect(within(dialog).getByText('2 KB')).toBeInTheDocument()

    await user.clear(mkv)
    await user.type(mkv, '2026-09-23T13:00')
    expect(mkv).toHaveAccessibleDescription('Editada por você')
    expect(mkv).not.toHaveAttribute('data-warning')

    await user.click(within(dialog).getByRole('button', { name: 'Remover reuniao-03.mkv' }))
    expect(within(dialog).getByRole('button', { name: 'Enviar 1 arquivo' })).toBeEnabled()
  })

  it('avisa quando os metadados trazem só o dia', async () => {
    vi.mocked(readRecordedAt).mockResolvedValue({ at: METADATA, source: 'metadata', precision: 'day', detail: 'date' })
    const { dialog } = await openWithFiles()
    const m4a = within(dialog).getByLabelText('Início da gravação de kickoff-guion.m4a')
    expect(m4a).toHaveAccessibleDescription('Só o dia nos metadados · a hora é a da modificação, confira')
    expect(m4a).toHaveAttribute('data-warning', 'true')
  })

  it('envia com a data confirmada, mostra a situação e o link, e atualiza a biblioteca', async () => {
    let finish!: (value: { recordingId: string; deduplicated: boolean }) => void
    vi.mocked(runUpload)
      .mockImplementationOnce(
        (_, options) =>
          new Promise((resolve) => {
            options?.onProgress?.({ phase: 'uploading', partsDone: 2, partsTotal: 5, bytesDone: 0, bytesTotal: 0 })
            finish = resolve
          }),
      )
      .mockResolvedValueOnce({ recordingId: '01928f3a-1c00-7a00-8000-000000000401', deduplicated: true })
    const { user, http, dialog } = await openWithFiles()

    await user.click(within(dialog).getByRole('button', { name: 'Enviar 2 arquivos' }))
    expect(await within(dialog).findByText('Enviando 3 de 5')).toBeInTheDocument()
    expect(vi.mocked(runUpload).mock.calls[0][0]).toMatchObject({
      recordedAt: new Date(toLocalInput(METADATA)).toISOString(),
      recordedAtSource: 'file_metadata',
    })

    // Fechar durante o envio só esconde o modal; a faixa da biblioteca acompanha.
    // O "Fechar" do rodapé (o do cabeçalho faz o mesmo).
    await user.click(within(dialog).getAllByRole('button', { name: 'Fechar' }).at(-1)!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const band = await screen.findByText(/Enviando 1 de 2 arquivos/)
    expect(band.closest('.alert')).toHaveClass('alert-info')

    const before = http.requests('GET /api/v1/recordings').length
    finish({ recordingId: '01928f3a-1c00-7a00-8000-0000000004a1', deduplicated: false })
    await waitFor(() => expect(screen.queryByText(/Enviando 1 de 2 arquivos/)).not.toBeInTheDocument())
    await waitFor(() => expect(http.requests('GET /api/v1/recordings').length).toBeGreaterThan(before))
    expect(vi.mocked(runUpload).mock.calls[1][0].recordedAtSource).toBe('user')

    await user.click(screen.getByRole('button', { name: 'Importar arquivos' }))
    const reopened = await screen.findByRole('dialog', { name: 'Importar arquivos' })
    expect(within(reopened).getAllByRole('link', { name: 'Abrir' }).map((link) => link.getAttribute('href'))).toEqual([
      '/gravacoes/01928f3a-1c00-7a00-8000-0000000004a1',
      '/gravacoes/01928f3a-1c00-7a00-8000-000000000401',
    ])
    expect(within(reopened).getByText(/Enviado ·/)).toBeInTheDocument()
    expect(within(reopened).getByText(/Já estava na biblioteca ·/)).toBeInTheDocument()
  }, 20_000)

  it('/importar leva ao modal aberto sobre a biblioteca', async () => {
    mockLibrary()
    renderApp('/importar')
    expect(await screen.findByRole('dialog', { name: 'Importar arquivos' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Biblioteca' })).toBeInTheDocument()
  })

  it('sem conexão segura, avisa e não deixa escolher arquivo', async () => {
    vi.mocked(checkEnvironment).mockReturnValue({ secureContext: false, webCodecs: false, subtleCrypto: false })
    mockLibrary()
    renderApp('/?importar=1')
    const dialog = await screen.findByRole('dialog', { name: 'Importar arquivos' })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('A conversão exige uma conexão segura.')
    expect(within(dialog).getByLabelText(/Solte áudio ou vídeo aqui/)).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
