import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => vi.unstubAllGlobals())

const base = {
  'GET /api/v1/me': () => fixtures.me(),
  'GET /api/v1/people': () => fixtures.personPage(),
}

describe('atribuição automática de locutores', () => {
  it('mostra o limiar e salva a mudança dele', async () => {
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

  it('desliga a atribuição pelo interruptor', async () => {
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

  it('não aparece com a identificação por voz desligada na plataforma', async () => {
    mockFetch({
      ...base,
      'GET /api/v1/me/voice-assignment': () => ({ ...fixtures.voiceAssignment(), platform_enabled: false }),
    })
    renderApp('/pessoas')
    await screen.findByRole('table', { name: 'Pessoas' })
    expect(screen.queryByRole('region', { name: 'Atribuição automática de locutores' })).not.toBeInTheDocument()
  })
})
