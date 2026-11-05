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
    'GET /api/v1/me/transcription': () => fixtures.transcriptionPreference(),
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
  it('opens over the library, reads the date of each file and shows the source', async () => {
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

    await user.click(within(dialog).getByRole('button', { name: 'Remover kickoff-guion.m4a' }))
    expect(within(dialog).getByRole('button', { name: 'Enviar arquivos' })).toBeDisabled()
  })

  it('picks the language of each file, starting from the account default', async () => {
    vi.mocked(runUpload).mockResolvedValue({ recordingId: '01928f3a-1c00-7a00-8000-000000000401', deduplicated: false })
    const { user, dialog } = await openWithFiles()
    const m4a = within(dialog).getByLabelText('Idioma de kickoff-guion.m4a')
    expect(m4a).toHaveValue('')
    expect(within(m4a).getByRole('option', { name: 'Padrão da conta: Inglês' })).toBeInTheDocument()
    await user.selectOptions(m4a, 'Detectar automaticamente')
    await user.click(within(dialog).getByRole('button', { name: 'Enviar 2 arquivos' }))
    await waitFor(() => expect(runUpload).toHaveBeenCalledTimes(2))
    expect(vi.mocked(runUpload).mock.calls[0][0].language).toBe('auto')
    expect(vi.mocked(runUpload).mock.calls[1][0].language).toBeUndefined()
  })

  it('warns when the metadata carries only the day', async () => {
    vi.mocked(readRecordedAt).mockResolvedValue({ at: METADATA, source: 'metadata', precision: 'day', detail: 'date' })
    const { dialog } = await openWithFiles()
    const m4a = within(dialog).getByLabelText('Início da gravação de kickoff-guion.m4a')
    expect(m4a).toHaveAccessibleDescription('Só o dia nos metadados · a hora é a da modificação, confira')
    expect(m4a).toHaveAttribute('data-warning', 'true')
  })

  it('uploads with the confirmed date, shows the status and the link, and refreshes the library', async () => {
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

    // Closing during upload only hides the modal; the library strip follows along.
    // The footer "Fechar" (the header one does the same).
    await user.click(within(dialog).getAllByRole('button', { name: 'Fechar' }).at(-1)!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const band = await screen.findByText(/Enviando 1 de 2 arquivos/)
    expect(band.closest('.alert')).toHaveClass('alert-info')

    const before = http.requests('GET /api/v1/recordings').length
    finish({ recordingId: '01928f3a-1c00-7a00-8000-0000000004a1', deduplicated: false })
    await waitFor(() => expect(screen.queryByText(/Enviando 1 de 2 arquivos/)).not.toBeInTheDocument())
    await waitFor(() => expect(http.requests('GET /api/v1/recordings').length).toBeGreaterThan(before))
    expect(vi.mocked(runUpload).mock.calls[1][0].recordedAtSource).toBe('user')

    // The uploaded row offers to turn on the browser notification; permission is only asked on click.
    const requestPermission = vi.fn(async () => 'granted' as const)
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })
    await user.click(screen.getByRole('button', { name: 'Importar arquivos' }))
    const reopened = await screen.findByRole('dialog', { name: 'Importar arquivos' })
    expect(requestPermission).not.toHaveBeenCalled()
    const offers = within(reopened).getAllByRole('button', { name: 'Avisar quando ficar pronta' })
    expect(offers).toHaveLength(1)
    await user.click(offers[0])
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('eclume-aviso-navegador')).toBe('on')
    await waitFor(() =>
      expect(within(reopened).queryByRole('button', { name: 'Avisar quando ficar pronta' })).not.toBeInTheDocument(),
    )
    expect(within(reopened).getAllByRole('link', { name: 'Abrir' }).map((link) => link.getAttribute('href'))).toEqual([
      '/gravacoes/01928f3a-1c00-7a00-8000-0000000004a1',
      '/gravacoes/01928f3a-1c00-7a00-8000-000000000401',
    ])
    expect(within(reopened).getByText(/Enviado ·/)).toBeInTheDocument()
    expect(within(reopened).getByText(/Já estava na biblioteca ·/)).toBeInTheDocument()
  }, 20_000)

  it('a failed row shows the reason in visible text and retries', async () => {
    vi.mocked(runUpload).mockRejectedValue(new Error('O servidor recusou o arquivo.'))
    const { user, dialog } = await openWithFiles()
    await user.click(within(dialog).getByRole('button', { name: 'Enviar 2 arquivos' }))
    const failed = await within(dialog).findAllByText(/^Falhou o envio: O servidor recusou o arquivo\./)
    expect(failed).toHaveLength(2)
    expect(failed[0]).toBeVisible()
    expect(failed[0]).not.toHaveAttribute('title')
    expect(within(failed[0]).getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument()
  })

  it('/importar leads to the modal open over the library', async () => {
    mockLibrary()
    renderApp('/importar')
    expect(await screen.findByRole('dialog', { name: 'Importar arquivos' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Biblioteca' })).toBeInTheDocument()
  })

  it('without a secure connection, warns and does not allow choosing a file', async () => {
    vi.mocked(checkEnvironment).mockReturnValue({ secureContext: false, webCodecs: false, subtleCrypto: false })
    mockLibrary()
    renderApp('/?importar=1')
    const dialog = await screen.findByRole('dialog', { name: 'Importar arquivos' })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('A conversão exige uma conexão segura.')
    expect(within(dialog).getByLabelText(/Solte áudio ou vídeo aqui/)).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('reads in English when the account chose English', async () => {
    const me = fixtures.me()
    mockFetch({
      'GET /api/v1/me': () => ({ ...me, user: { ...me.user, locale: 'en' } }),
      'GET /api/v1/recordings': () => fixtures.recordingWeekPage(),
      'GET /api/v1/tags': () => fixtures.tagList(),
      'GET /api/v1/collections': () => fixtures.collectionPage(),
      'GET /api/v1/fields': () => fixtures.fieldPage(),
      'GET /api/v1/people': () => fixtures.personPage(),
      'GET /api/v1/me/transcription': () => fixtures.transcriptionPreference(),
    })
    const user = userEvent.setup()
    renderApp('/?importar=1')
    const dialog = await screen.findByRole('dialog', { name: 'Import files' })
    await user.upload(within(dialog).getByLabelText(/Drop audio or video here/), files())
    await waitFor(() => expect(within(dialog).getAllByText('Ready to upload')).toHaveLength(2))
    expect(within(dialog).getByLabelText('Start of the recording of kickoff-guion.m4a')).toHaveAccessibleDescription(
      'From the file metadata',
    )
    expect(within(dialog).getByRole('button', { name: 'Upload 2 files' })).toBeEnabled()
    expect(within(dialog).getByRole('columnheader', { name: 'Status' })).toBeInTheDocument()
  })
})
