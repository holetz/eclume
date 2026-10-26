import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'
import { WHISPER_LANGUAGE_CODES, whisperLanguages } from '../../lib/languages'

beforeAll(() => preloadRoute('/admin/transcricao'))

afterEach(() => vi.unstubAllGlobals())

function mockSettingsApi(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/admin/me': () => fixtures.adminMe(),
    'GET /api/v1/privacy': () => fixtures.privacyInfo(),
    'GET /api/v1/admin/settings': () => fixtures.adminSettings(),
    ...extra,
  })
}

describe('Whisper languages', () => {
  it('are the 100 from the tokenizer, named in pt-BR and in order', () => {
    expect(new Set(WHISPER_LANGUAGE_CODES).size).toBe(100)
    const languages = whisperLanguages()
    const labels = languages.map((option) => option.label)
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'pt-BR')))
    const byCode = Object.fromEntries(languages.map((option) => [option.value, option.label]))
    expect(byCode.pt).toBe('Português')
    expect(byCode.yue).toBe('Cantonês')
    expect(byCode.jw).toBe('Javanês')
  })
})

describe('Transcription', () => {
  it('shows the DS engine, model and language and saves only the asr block', async () => {
    const http = mockSettingsApi({
      'PATCH /api/v1/admin/settings': async (request) => {
        const settings = fixtures.adminSettings()
        return { ...settings, asr: { ...settings.asr, ...(await request.json()).asr } }
      },
    })
    renderApp('/admin/transcricao')
    expect(await screen.findByRole('heading', { level: 1, name: 'Transcrição' })).toBeInTheDocument()
    const engine = await screen.findByRole('radiogroup', { name: 'Motor' })
    expect(within(engine).getAllByRole('radio').map((radio) => radio.closest('label')!.textContent)).toEqual([
      'WhisperX (GPU)',
      'Remoto (OpenAI-compatível)',
      'CPU',
    ])
    expect(within(engine).getByRole('radio', { name: 'WhisperX (GPU)' })).toBeChecked()
    const model = screen.getByLabelText('Modelo')
    expect(model).toHaveValue('large-v3-turbo')
    const language = screen.getByLabelText('Idioma')
    expect(language).toHaveValue('pt')
    expect(within(language).getByRole('group', { name: 'Idiomas (100)' })).toBeInTheDocument()
    expect(screen.getByLabelText('Tipo de computação')).toHaveValue('int8_float16')
    expect(within(screen.getByLabelText('Tipo de computação')).queryByText(/^float16/)).not.toBeInTheDocument()
    // Diarization moved off this screen.
    expect(screen.queryByLabelText(/locutores/)).not.toBeInTheDocument()
    const form = screen.getByRole('form', { name: 'Configuração de transcrição' })
    expect(within(form).getByRole('link', { name: 'Locutores' })).toHaveAttribute('href', '/admin/locutores')
    expect(screen.getByText(/Última alteração por Administrator/)).toBeInTheDocument()

    const save = screen.getByRole('button', { name: 'Salvar' })
    expect(save).toBeDisabled()
    await userEvent.selectOptions(model, 'large-v3')
    await userEvent.selectOptions(language, 'en')
    await userEvent.type(screen.getByLabelText('Lote do ASR'), '2')
    expect(save).toBeEnabled()
    await userEvent.click(save)
    expect(await screen.findByText('Configuração salva.')).toBeInTheDocument()

    const sent = await http.requests('PATCH /api/v1/admin/settings')[0].json()
    expect(Object.keys(sent)).toEqual(['asr'])
    expect(sent.asr).toEqual({
      engine: 'whisperx-local',
      model: 'large-v3',
      compute_type: 'int8_float16',
      batch_size: 2,
      default_language: 'en',
      fallback_model: 'medium',
      endpoint_url: null,
    })
  })

  it('asks for the address of the remote engine and shows the server error', async () => {
    mockSettingsApi({
      'PATCH /api/v1/admin/settings': () =>
        problem('validation_failed', 422, { errors: [{ field: 'asr.endpoint_url', message: 'obrigatória' }] }),
    })
    renderApp('/admin/transcricao')
    await userEvent.click(await screen.findByRole('radio', { name: 'Remoto (OpenAI-compatível)' }))
    const save = screen.getByRole('button', { name: 'Salvar' })
    expect(save).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Endereço do servidor remoto'), 'http://speaches:8000/v1')
    await userEvent.click(save)
    expect(await screen.findByRole('alert')).toHaveTextContent('asr.endpoint_url: obrigatória')
  })

  it('shows a saved model and language outside the lists', async () => {
    const settings = fixtures.adminSettings()
    settings.asr.model = 'distil-large-v3'
    settings.asr.default_language = 'pt-BR'
    mockSettingsApi({ 'GET /api/v1/admin/settings': () => settings })
    renderApp('/admin/transcricao')
    expect(await screen.findByLabelText('Modelo')).toHaveValue('distil-large-v3')
    expect(screen.getByLabelText('Idioma')).toHaveValue('pt-BR')
  })

  it('offers automatic language detection', async () => {
    const http = mockSettingsApi({ 'PATCH /api/v1/admin/settings': () => fixtures.adminSettings() })
    renderApp('/admin/transcricao')
    const language = await screen.findByLabelText('Idioma')
    await userEvent.selectOptions(language, 'Detectar automaticamente')
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByText('Configuração salva.')).toBeInTheDocument()
    const sent = await http.requests('PATCH /api/v1/admin/settings')[0].json()
    expect(sent.asr.default_language).toBe('auto')
  })

  it('warns when the remote engine sends audio off the server', async () => {
    mockSettingsApi({
      'GET /api/v1/privacy': () => ({
        destinations: [{ purpose: 'transcription', location: 'external', processor: 'asr.example.com' }],
      }),
    })
    renderApp('/admin/transcricao')
    const note = await screen.findByRole('note', { name: 'Dados fora do servidor' })
    expect(note).toHaveTextContent('transcrição do áudio (asr.example.com)')
  })

  it('with no external destination, does not warn', async () => {
    mockSettingsApi()
    renderApp('/admin/transcricao')
    expect(await screen.findByRole('form', { name: 'Configuração de transcrição' })).toBeInTheDocument()
    expect(screen.queryByRole('note', { name: 'Dados fora do servidor' })).not.toBeInTheDocument()
  })
})
