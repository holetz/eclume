import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/admin/locutores', '/admin/voz'))

afterEach(() => vi.unstubAllGlobals())

type Settings = Schemas['AdminSettings']

function mockSpeakersApi(settings: Settings = fixtures.adminSettings(), extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/admin/me': () => fixtures.adminMe(),
    'GET /api/v1/admin/settings': () => settings,
    'GET /api/v1/admin/secrets': () => fixtures.secretList(),
    // The server returns the settings with what was sent.
    'PATCH /api/v1/admin/settings': async (request) => {
      const sent = await request.json()
      return {
        ...settings,
        diarization: { ...settings.diarization, ...sent.diarization },
        voice_identification: { ...settings.voice_identification, ...sent.voice_identification },
      }
    },
    ...extra,
  })
}

const sentBody = (http: ReturnType<typeof mockFetch>) => http.requests('PATCH /api/v1/admin/settings')[0].json()

describe('Speakers', () => {
  it('shows the DS diarization and identification and saves both blocks', async () => {
    const http = mockSpeakersApi()
    renderApp('/admin/locutores')
    expect(await screen.findByRole('heading', { level: 2, name: '1 · Separação' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Locutores' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Separar os locutores com pyannote' })).toBeChecked()
    const hf = screen.getByRole('group', { name: 'Token do Hugging Face' })
    expect(within(hf).getByText('•••••••• guardado')).toBeInTheDocument()
    expect(within(hf).getByText(/Só escrita · atualizado em 14\/09\/2026/)).toBeInTheDocument()
    const speakers = screen.getByRole('radiogroup', { name: 'Pessoas esperadas' })
    expect(within(speakers).getByRole('radio', { name: 'Detectar' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Sugerir quem está falando pelas amostras de voz' })).toBeChecked()
    const threshold = screen.getByLabelText('Limiar de correspondência · 0,75')
    const save = screen.getByRole('button', { name: 'Salvar' })
    expect(save).toBeDisabled()

    await userEvent.click(within(speakers).getByRole('radio', { name: '3–6' }))
    fireEvent.change(threshold, { target: { value: '0.8' } })
    expect(screen.getByLabelText('Limiar de correspondência · 0,80')).toBeInTheDocument()
    await userEvent.click(save)
    expect(await screen.findByText('Configuração salva.')).toBeInTheDocument()
    expect(await sentBody(http)).toEqual({
      diarization: { enabled: true, min_speakers: 3, max_speakers: 6 },
      voice_identification: { enabled: true, suggestion_threshold: 0.8 },
    })
  })

  it('turning diarization off turns identification off and asks to confirm the purge', async () => {
    const http = mockSpeakersApi()
    renderApp('/admin/locutores')
    await userEvent.click(await screen.findByRole('switch', { name: 'Separar os locutores com pyannote' }))
    const identify = screen.getByRole('switch', { name: 'Sugerir quem está falando pelas amostras de voz' })
    expect(identify).not.toBeChecked()
    expect(identify).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    const dialog = screen.getByRole('dialog', { name: 'Desligar a identificação por voz?' })
    expect(dialog).toHaveTextContent('Desligar apaga todas as impressões de voz da plataforma')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(http.requests('PATCH /api/v1/admin/settings')).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Desligar e salvar' }))
    expect(await screen.findByText('Configuração salva.')).toBeInTheDocument()
    expect(await sentBody(http)).toEqual({
      diarization: { enabled: false, min_speakers: null, max_speakers: null },
      voice_identification: { enabled: false, suggestion_threshold: 0.75 },
    })
  })

  it('keeps expected people outside the options as Personalizado', async () => {
    const settings = fixtures.adminSettings()
    settings.diarization.min_speakers = 2
    settings.diarization.max_speakers = 5
    settings.voice_identification.suggestion_threshold = 0.45
    const http = mockSpeakersApi(settings)
    renderApp('/admin/locutores')
    const speakers = await screen.findByRole('radiogroup', { name: 'Pessoas esperadas' })
    expect(within(speakers).getByRole('radio', { name: 'Personalizado (2–5)' })).toBeChecked()
    // A threshold saved below 0,50 shows as it is.
    expect(screen.getByLabelText('Limiar de correspondência · 0,45')).toHaveValue('0.45')
    await userEvent.click(screen.getByRole('switch', { name: 'Sugerir quem está falando pelas amostras de voz' }))
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Desligar e salvar' }))
    expect((await sentBody(http)).diarization).toEqual({ enabled: true, min_speakers: 2, max_speakers: 5 })
  })

  it('saves, replaces and deletes the Hugging Face token at once', async () => {
    const secrets = fixtures.secretList()
    const http = mockSpeakersApi(fixtures.adminSettings(), {
      'GET /api/v1/admin/secrets': () => secrets,
      'PUT /api/v1/admin/secrets/:name': () => {
        secrets.items[0] = { ...secrets.items[0], is_set: true, updated_at: '2026-09-27T10:00:00Z' }
        return empty(204)
      },
      'DELETE /api/v1/admin/secrets/:name': () => {
        secrets.items[0] = { ...secrets.items[0], is_set: false, updated_at: null }
        return empty(204)
      },
    })
    renderApp('/admin/locutores')
    const hf = await screen.findByRole('group', { name: 'Token do Hugging Face' })
    await userEvent.click(within(hf).getByRole('button', { name: 'Substituir' }))
    const input = within(hf).getByLabelText('Token do Hugging Face')
    expect(input).toHaveAttribute('type', 'password')
    await userEvent.type(input, 'hf_novo{Enter}')
    expect(await within(hf).findByText(/atualizado em 27\/09\/2026/)).toBeInTheDocument()
    const put = http.requests('PUT /api/v1/admin/secrets/:name')[0]
    expect(new URL(put.url).pathname).toBe('/api/v1/admin/secrets/hf_token')
    expect(await put.json()).toEqual({ value: 'hf_novo' })
    expect(screen.queryByText('hf_novo')).not.toBeInTheDocument()
    // Enter in the secret does not save the page form.
    expect(http.requests('PATCH /api/v1/admin/settings')).toHaveLength(0)

    await userEvent.click(within(hf).getByRole('button', { name: 'Apagar' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apagar' }))
    expect(await screen.findByText('Sem o token, a transcrição sai com um locutor só.')).toBeInTheDocument()
    expect(http.requests('DELETE /api/v1/admin/secrets/:name')).toHaveLength(1)
    expect(within(hf).getByLabelText('Token do Hugging Face')).toHaveValue('')
  })

  it('the old voice route leads to Locutores', async () => {
    mockSpeakersApi()
    renderApp('/admin/voz')
    expect(await screen.findByRole('heading', { level: 1, name: 'Locutores' })).toBeInTheDocument()
  })
})
