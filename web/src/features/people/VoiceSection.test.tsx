import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'
import { exportFilename } from './voice'

afterEach(() => vi.unstubAllGlobals())

const RAFAEL = '01928f3a-1c00-7a00-8000-000000000302'

function withoutConsent() {
  const voiceprint = fixtures.voiceprint()
  voiceprint.consent = { status: 'none', updated_at: null, term_version: null, recorded_by: null, sample_count: 0 }
  voiceprint.sample_count = 0
  voiceprint.samples = []
  return voiceprint
}

function mockVoice(extra: Parameters<typeof mockFetch>[0] = {}, role: 'admin' | 'member' = 'admin') {
  return mockFetch({
    'GET /api/v1/me': () => {
      const me = fixtures.me()
      me.user.role = role
      return me
    },
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
  it('mostra o consentimento, quem registrou e as amostras', async () => {
    mockVoice()
    const voice = await openVoice()
    expect(await within(voice).findByText('Consentimento registrado')).toBeInTheDocument()
    expect(within(voice).getByText(/por Mariana Couto, .* termo v1/)).toBeInTheDocument()
    expect(within(voice).getByText(/2 amostras na impressão de voz/)).toBeInTheDocument()
    const samples = within(voice).getByRole('list', { name: 'Amostras da impressão de voz' })
    expect(within(samples).getByText('Alinhamento do programa de lideranças')).toBeInTheDocument()
    expect(within(samples).getByText('Gravação que você não vê')).toBeInTheDocument()
  })

  it('registra o consentimento só depois de mostrar o termo e marcar o aceite', async () => {
    let voiceprint = withoutConsent()
    const http = mockVoice({
      'GET /api/v1/people/:id/voiceprint': () => voiceprint,
      'PUT /api/v1/people/:id/voice-consent': () => {
        voiceprint = fixtures.voiceprint()
        return fixtures.person()
      },
    })
    const voice = await openVoice()
    expect(await within(voice).findByText('Sem consentimento')).toBeInTheDocument()
    await userEvent.click(within(voice).getByRole('button', { name: 'Registrar consentimento' }))
    const form = within(voice).getByRole('form', { name: 'Registrar consentimento de voz' })
    expect(within(form).getByText(/Termo de consentimento \(versão 1\)/)).toBeInTheDocument()
    expect(within(form).getByText(/LGPD, art. 11/)).toBeInTheDocument()
    const submit = within(form).getByRole('button', { name: 'Registrar' })
    expect(submit).toBeDisabled()
    await userEvent.type(within(form).getByLabelText('Como o consentimento foi colhido'), 'Termo assinado.')
    await userEvent.click(within(form).getByLabelText('A pessoa leu e aceitou este termo'))
    await userEvent.click(submit)
    expect(await within(voice).findByText('Consentimento registrado')).toBeInTheDocument()
    expect(await http.requests('PUT /api/v1/people/:id/voice-consent')[0].json()).toEqual({
      status: 'granted',
      notes: 'Termo assinado.',
    })
  })

  it('revoga e exclui a impressão com confirmação', async () => {
    const http = mockVoice({
      'PUT /api/v1/people/:id/voice-consent': () => fixtures.person(),
      'DELETE /api/v1/people/:id/voiceprint': () => empty(),
    })
    const voice = await openVoice()
    await userEvent.click(await within(voice).findByRole('button', { name: 'Revogar consentimento' }))
    expect(within(voice).getByText(/Revogar apaga a impressão de voz/)).toBeInTheDocument()
    await userEvent.click(within(voice).getByRole('button', { name: 'Confirmar revogação' }))
    expect(await http.requests('PUT /api/v1/people/:id/voice-consent')[0].json()).toEqual({ status: 'revoked' })

    await userEvent.click(await within(voice).findByRole('button', { name: 'Excluir impressão' }))
    await userEvent.click(within(voice).getByRole('button', { name: 'Confirmar exclusão da impressão' }))
    expect(await screen.findByText('Impressão de voz excluída.')).toBeInTheDocument()
    expect(http.requests('DELETE /api/v1/people/:id/voiceprint')).toHaveLength(1)
  })

  it('avisa quando o opt-in da organização está desligado', async () => {
    mockVoice({ 'GET /api/v1/people/:id/voiceprint': () => ({ ...withoutConsent(), opt_in: false }) })
    const voice = await openVoice()
    expect(await within(voice).findByText(/identificação por voz está desligada/)).toBeInTheDocument()
  })

  it('exporta só para admin', async () => {
    const createObjectURL = vi.fn(() => 'blob:voz')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    const http = mockVoice({ 'GET /api/v1/people/:id/voiceprint/export': () => fixtures.voiceprintExport() })
    const voice = await openVoice()
    await userEvent.click(await within(voice).findByRole('button', { name: 'Exportar dados de voz' }))
    expect(http.requests('GET /api/v1/people/:id/voiceprint/export')).toHaveLength(1)
    expect(createObjectURL).toHaveBeenCalled()
    expect(exportFilename('Rafael Lima')).toBe('voz-rafael-lima.json')
  })

  it('esconde a exportação de quem não é admin', async () => {
    mockVoice({}, 'member')
    const voice = await openVoice()
    await within(voice).findByText('Consentimento registrado')
    expect(within(voice).queryByRole('button', { name: 'Exportar dados de voz' })).not.toBeInTheDocument()
  })
})
