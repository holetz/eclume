import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => vi.unstubAllGlobals())

function mockVoiceAdmin(extra: Parameters<typeof mockFetch>[0] = {}) {
  const settings = fixtures.adminSettings()
  settings.voice_identification.enabled = false
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/admin/settings': () => settings,
    'GET /api/v1/admin/voice-audit': () => fixtures.voiceAuditPage(),
    ...extra,
  })
}

describe('Identificação por voz no admin', () => {
  it('liga o opt-in, ajusta o limiar e troca o termo', async () => {
    const http = mockVoiceAdmin({
      'PATCH /api/v1/admin/settings': () => fixtures.adminSettings(),
    })
    renderApp('/admin/voz')
    const optIn = await screen.findByRole('checkbox', { name: /Ligar a identificação por voz/ })
    expect(optIn).not.toBeChecked()
    expect(screen.getByLabelText('Semelhança mínima para sugerir (%)')).toHaveValue(75)
    await userEvent.click(optIn)
    const threshold = screen.getByLabelText('Semelhança mínima para sugerir (%)')
    await userEvent.clear(threshold)
    await userEvent.type(threshold, '62')
    const term = screen.getByLabelText('Texto que a pessoa aceita')
    await userEvent.clear(term)
    await userEvent.type(term, 'Termo novo.')
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByText('Configuração de voz salva.')).toBeInTheDocument()
    expect(await http.requests('PATCH /api/v1/admin/settings')[0].json()).toEqual({
      voice_identification: { enabled: true, suggestion_threshold: 0.62, consent_term_text: 'Termo novo.' },
    })
  })

  it('não reenvia o termo quando ele não mudou', async () => {
    const http = mockVoiceAdmin({ 'PATCH /api/v1/admin/settings': () => fixtures.adminSettings() })
    renderApp('/admin/voz')
    await userEvent.click(await screen.findByRole('checkbox', { name: /Ligar a identificação por voz/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await screen.findByText('Configuração de voz salva.')
    expect(await http.requests('PATCH /api/v1/admin/settings')[0].json()).toEqual({
      voice_identification: { enabled: true, suggestion_threshold: 0.75 },
    })
  })

  it('mostra a trilha de auditoria em português', async () => {
    mockVoiceAdmin()
    renderApp('/admin/voz')
    const table = await screen.findByRole('table', { name: 'Eventos de voz mais recentes' })
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(4)
    expect(rows[1]).toHaveTextContent('Sugestão aceita')
    expect(rows[1]).toHaveTextContent('Mariana Couto')
    expect(rows[1]).toHaveTextContent('82%')
    expect(rows[2]).toHaveTextContent('Sistema')
  })

  it('apaga todas as impressões com confirmação', async () => {
    const http = mockVoiceAdmin({
      'DELETE /api/v1/admin/voiceprints': () => ({ deleted_samples: 7, deleted_suggestions: 2 }),
    })
    renderApp('/admin/voz')
    await userEvent.click(await screen.findByRole('button', { name: 'Apagar todas as impressões' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar: apagar todas' }))
    expect(await screen.findByText('7 amostras e 2 sugestões apagadas.')).toBeInTheDocument()
    expect(http.requests('DELETE /api/v1/admin/voiceprints')).toHaveLength(1)
  })
})
