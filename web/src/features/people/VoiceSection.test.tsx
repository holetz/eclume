import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => vi.unstubAllGlobals())

const RAFAEL = '01928f3a-1c00-7a00-8000-000000000302'

function mockVoice(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/people/:id': () => fixtures.person(),
    'GET /api/v1/people/:id/transcripts': () => fixtures.transcriptPage(),
    'GET /api/v1/people/:id/voiceprint': () => fixtures.voiceprint(),
    'GET /api/v1/search': () => fixtures.searchPage(),
    ...extra,
  })
}

async function openVoice() {
  renderApp(`/pessoas/${RAFAEL}`)
  return screen.findByRole('region', { name: 'Voz' })
}

describe('seção Voz da pessoa', () => {
  it('mostra as amostras, sem consentimento por pessoa', async () => {
    mockVoice()
    const voice = await openVoice()
    expect(await within(voice).findByText(/2 amostras na impressão de voz/)).toBeInTheDocument()
    const samples = within(voice).getByRole('list', { name: 'Amostras da impressão de voz' })
    expect(within(samples).getByText('Alinhamento do programa de lideranças')).toBeInTheDocument()
    expect(within(samples).getByText('Gravação excluída')).toBeInTheDocument()
    // O aceite do aviso no cadastro substitui o consentimento de cada pessoa.
    expect(within(voice).queryByText(/consentimento/i)).not.toBeInTheDocument()
    expect(within(voice).queryByRole('button', { name: /Exportar/ })).not.toBeInTheDocument()
  })

  it('esquece a voz com confirmação', async () => {
    const http = mockVoice({ 'DELETE /api/v1/people/:id/voiceprint': () => empty() })
    const voice = await openVoice()
    await userEvent.click(await within(voice).findByRole('button', { name: 'Esquecer a voz' }))
    expect(within(voice).getByText(/Esquecer apaga todas as amostras/)).toBeInTheDocument()
    await userEvent.click(within(voice).getByRole('button', { name: 'Confirmar: esquecer a voz' }))
    expect(await screen.findByText('Voz esquecida.')).toBeInTheDocument()
    expect(http.requests('DELETE /api/v1/people/:id/voiceprint')).toHaveLength(1)
  })

  it('avisa quando a identificação por voz está desligada', async () => {
    mockVoice({
      'GET /api/v1/people/:id/voiceprint': () => ({ ...fixtures.voiceprint(), enabled: false, sample_count: 0, samples: [] }),
    })
    const voice = await openVoice()
    expect(await within(voice).findByText(/identificação por voz está desligada/)).toBeInTheDocument()
    expect(within(voice).queryByRole('button', { name: 'Esquecer a voz' })).not.toBeInTheDocument()
  })
})
