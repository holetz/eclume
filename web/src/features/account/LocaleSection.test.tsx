import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { i18n } from '../../i18n'
import { fixtures } from '../../test/fixtures'
import { mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/config/conta'))

afterEach(() => vi.unstubAllGlobals())

const base = {
  'GET /api/v1/me': () => fixtures.me(),
  'GET /api/v1/privacy': () => fixtures.privacyInfo(),
  'GET /api/v1/me/voice-assignment': () => fixtures.voiceAssignment(),
  'GET /api/v1/me/transcription': () => fixtures.transcriptionPreference(),
  'GET /api/v1/me/audio-retention': () => fixtures.audioRetention(),
}

const answer = (locale: 'en' | 'pt-BR' | null) => ({
  locale,
  effective: locale ?? 'pt-BR',
  default: 'en',
  supported: ['en', 'pt-BR'],
})

describe('interface language', () => {
  it('saves the chosen locale and switches the screen at once', async () => {
    const http = mockFetch({ ...base, 'PATCH /api/v1/me/locale': () => answer('en') })
    renderApp('/config/conta')
    const select = await screen.findByLabelText('Idioma da interface')
    expect(select).toHaveValue('pt-BR')
    await userEvent.selectOptions(select, 'English')
    expect(await screen.findByLabelText('Interface language')).toHaveValue('en')
    expect(screen.getByRole('heading', { name: 'Language' })).toBeInTheDocument()
    expect(i18n.language).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(await http.requests('PATCH /api/v1/me/locale')[0].json()).toEqual({ locale: 'en' })
  })

  it('drops the choice and follows the browser language', async () => {
    const http = mockFetch({ ...base, 'PATCH /api/v1/me/locale': () => answer(null) })
    renderApp('/config/conta')
    const select = await screen.findByLabelText('Idioma da interface')
    await userEvent.selectOptions(select, 'Idioma do navegador')
    await waitFor(() => expect(select).toHaveValue(''))
    expect(await http.requests('PATCH /api/v1/me/locale')[0].json()).toEqual({ locale: null })
    expect(i18n.language).toBe('pt-BR')
  })

  it('keeps the stored locale when the server refuses', async () => {
    mockFetch({ ...base, 'PATCH /api/v1/me/locale': () => problem('session_required', 403) })
    renderApp('/config/conta')
    const select = await screen.findByLabelText('Idioma da interface')
    await userEvent.selectOptions(select, 'English')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(select).toHaveValue('pt-BR')
    expect(i18n.language).toBe('pt-BR')
  })
})
