import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkEnvironment, convertAudio, MediaConvertError, probeMedia } from '../../lib/media-convert'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'
import { cancelUpload, runUpload, type UploadOptions } from '../../upload/multipart'
import { fileStem } from './useImport'

vi.mock('../../lib/media-convert', async (original) => ({
  ...(await original<typeof import('../../lib/media-convert')>()),
  checkEnvironment: vi.fn(),
  convertAudio: vi.fn(),
  probeMedia: vi.fn(),
}))
vi.mock('../../upload/multipart', async (original) => ({
  ...(await original<typeof import('../../upload/multipart')>()),
  runUpload: vi.fn(),
  cancelUpload: vi.fn(),
}))

const opus = new Blob(['OggS'], { type: 'audio/ogg; codecs=opus' })
const video = new File([new Uint8Array(2048)], 'Reunião de kick-off.mp4', { type: 'video/mp4' })

beforeEach(() => {
  vi.mocked(checkEnvironment).mockReturnValue({ secureContext: true, webCodecs: true, subtleCrypto: true })
  vi.mocked(probeMedia).mockResolvedValue({ durationSec: 3600, hasAudio: true, estimatedBytes: 14_688_000, engine: 'webcodecs' })
  vi.mocked(convertAudio).mockImplementation(async (_file, options) => {
    options?.onProgress?.({ ratio: 0.5, bytesRead: 1024, bytesTotal: 2048 })
    return { blob: opus, sha256: 'ab'.repeat(32), durationSec: 3600, engine: 'webcodecs' }
  })
  mockFetch({ 'GET /api/v1/me': () => fixtures.me() })
})

afterEach(() => {
  for (const fn of [checkEnvironment, convertAudio, probeMedia, runUpload, cancelUpload]) vi.mocked(fn).mockReset()
  vi.unstubAllGlobals()
})

async function chooseFile() {
  renderApp('/importar')
  await userEvent.upload(await screen.findByLabelText('Escolher arquivo'), video)
  expect(await screen.findByText(/Duração 1 h 00 min · deve subir cerca de 14 MB/)).toBeInTheDocument()
}

/** runUpload que só termina quando o sinal aborta (para pausar e cancelar). */
function hangingUpload() {
  vi.mocked(runUpload).mockImplementationOnce((_file, options?: UploadOptions) => {
    options?.onCreated?.('up-1')
    options?.onProgress?.({ phase: 'uploading', partsDone: 1, partsTotal: 3, bytesDone: 4, bytesTotal: 10 })
    return new Promise((_, reject) =>
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason)),
    )
  })
}

describe('import', () => {
  it('converte, envia o Opus com hash e título e leva à gravação', async () => {
    vi.mocked(runUpload).mockResolvedValue({ recordingId: 'rec-9', deduplicated: false })
    await chooseFile()
    const title = screen.getByLabelText('Título da gravação')
    expect(title).toHaveValue('Reunião de kick-off')
    await userEvent.clear(title)
    await userEvent.type(title, 'Kick-off do programa')
    await userEvent.click(screen.getByRole('button', { name: 'Converter e enviar' }))

    expect(await screen.findByText('Arquivo enviado. A transcrição entrou na fila.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Acompanhar a gravação' })).toHaveAttribute('href', '/gravacoes/rec-9')
    expect(convertAudio).toHaveBeenCalledWith(video, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(vi.mocked(runUpload).mock.calls[0][0]).toEqual({
      blob: opus,
      sha256: 'ab'.repeat(32),
      filename: 'Reunião de kick-off.ogg',
      contentType: 'audio/ogg; codecs=opus',
      title: 'Kick-off do programa',
      durationMs: 3_600_000,
    })
  })

  it('avisa quando o áudio já estava na biblioteca', async () => {
    vi.mocked(runUpload).mockResolvedValue({ recordingId: 'rec-1', deduplicated: true })
    await chooseFile()
    await userEvent.click(screen.getByRole('button', { name: 'Converter e enviar' }))
    expect(await screen.findByText(/já estava na sua biblioteca/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Abrir a gravação' })).toHaveAttribute('href', '/gravacoes/rec-1')
  })

  it('pausa e retoma o mesmo upload, sem reconverter', async () => {
    hangingUpload()
    vi.mocked(runUpload).mockResolvedValueOnce({ recordingId: 'rec-9', deduplicated: false })
    await chooseFile()
    await userEvent.click(screen.getByRole('button', { name: 'Converter e enviar' }))
    expect(await screen.findAllByText('Parte 1 de 3')).not.toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Pausar' }))
    expect(await screen.findAllByText('Envio pausado')).not.toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Retomar' }))

    expect(await screen.findByText('Arquivo enviado. A transcrição entrou na fila.')).toBeInTheDocument()
    expect(vi.mocked(runUpload).mock.calls[1][1]?.uploadId).toBe('up-1')
    expect(convertAudio).toHaveBeenCalledTimes(1)
  })

  it('cancelar aborta o upload no servidor e volta ao arquivo escolhido', async () => {
    hangingUpload()
    vi.mocked(cancelUpload).mockResolvedValue()
    await chooseFile()
    await userEvent.click(screen.getByRole('button', { name: 'Converter e enviar' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancelar' }))
    expect(cancelUpload).toHaveBeenCalledWith('up-1')
    expect(await screen.findByRole('button', { name: 'Converter e enviar' })).toBeInTheDocument()
  })

  it('mostra o erro da conversão e deixa tentar de novo', async () => {
    vi.mocked(convertAudio).mockRejectedValueOnce(new MediaConvertError('no-audio'))
    vi.mocked(runUpload).mockResolvedValue({ recordingId: 'rec-9', deduplicated: false })
    await chooseFile()
    await userEvent.click(screen.getByRole('button', { name: 'Converter e enviar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('O arquivo não tem faixa de áudio.')
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await waitFor(() => expect(convertAudio).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Arquivo enviado. A transcrição entrou na fila.')).toBeInTheDocument()
  })

  it('sem conexão segura, explica e não deixa escolher arquivo', async () => {
    vi.mocked(checkEnvironment).mockReturnValue({ secureContext: false, webCodecs: false, subtleCrypto: false })
    renderApp('/importar')
    expect(await screen.findByRole('alert')).toHaveTextContent(/conexão segura/)
    expect(screen.getByLabelText('Escolher arquivo')).toBeDisabled()
  })

  it('deriva o título do nome do arquivo', () => {
    expect(fileStem('2026-09-18 Teams.opus')).toBe('2026-09-18 Teams')
    expect(fileStem('.oculto')).toBe('.oculto')
    expect(fileStem('sem-extensao')).toBe('sem-extensao')
  })
})
