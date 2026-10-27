import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/pessoas'))

afterEach(() => vi.unstubAllGlobals())

const base = {
  'GET /api/v1/me': () => fixtures.me(),
  'GET /api/v1/people': () => fixtures.personPage(),
}

describe('automatic speaker assignment', () => {
  it('shows the threshold and saves its change', async () => {
    const http = mockFetch({
      ...base,
      'GET /api/v1/me/voice-assignment': () => fixtures.voiceAssignment(),
      'PATCH /api/v1/me/voice-assignment': async (request) => ({
        ...fixtures.voiceAssignment(),
        ...(await request.json()),
      }),
    })
    renderApp('/pessoas')
    const slider = await screen.findByRole('slider', { name: /Pontuação mínima/ })
    expect(slider).toHaveValue('0.8')
    expect(screen.getByText('80%')).toBeInTheDocument()
    fireEvent.change(slider, { target: { value: '0.9' } })
    fireEvent.blur(slider)
    expect(await screen.findByText('90%')).toBeInTheDocument()
    await vi.waitFor(() => expect(http.requests('PATCH /api/v1/me/voice-assignment')).toHaveLength(1))
    expect(await http.requests('PATCH /api/v1/me/voice-assignment')[0].json()).toEqual({ threshold: 0.9 })
  })

  it('turns the assignment off with the switch', async () => {
    const http = mockFetch({
      ...base,
      'GET /api/v1/me/voice-assignment': () => fixtures.voiceAssignment(),
      'PATCH /api/v1/me/voice-assignment': () => ({ ...fixtures.voiceAssignment(), enabled: false }),
    })
    renderApp('/pessoas')
    await userEvent.click(await screen.findByRole('switch', { name: /automaticamente pela voz/ }))
    await vi.waitFor(() => expect(screen.getByRole('slider', { name: /Pontuação mínima/ })).toBeDisabled())
    expect(await http.requests('PATCH /api/v1/me/voice-assignment')[0].json()).toEqual({ enabled: false })
  })

  it('does not show with voice identification turned off on the platform', async () => {
    mockFetch({
      ...base,
      'GET /api/v1/me/voice-assignment': () => ({ ...fixtures.voiceAssignment(), platform_enabled: false }),
    })
    renderApp('/pessoas')
    await screen.findByRole('table', { name: 'Pessoas' })
    expect(screen.queryByRole('region', { name: 'Atribuição automática de locutores' })).not.toBeInTheDocument()
  })

  it('warns, without the switch, when the account does not keep voice samples', async () => {
    mockFetch({
      ...base,
      'GET /api/v1/me/voice-assignment': () => ({ ...fixtures.voiceAssignment(), keep_samples: false }),
    })
    renderApp('/pessoas')
    expect(await screen.findByText(/não guarda amostras de voz/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Conta › Privacidade e dados' })).toHaveAttribute('href', '/config/conta')
    expect(screen.queryByRole('switch', { name: /automaticamente pela voz/ })).not.toBeInTheDocument()
  })
})
