import { screen } from '@testing-library/react'
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
    'GET /api/v1/admin/me': () => fixtures.adminMe(),
    'GET /api/v1/admin/settings': () => settings,
    ...extra,
  })
}

describe('Identificação por voz no admin', () => {
  it('liga a identificação por voz e ajusta o limiar', async () => {
    const http = mockVoiceAdmin({
      'PATCH /api/v1/admin/settings': () => fixtures.adminSettings(),
    })
    renderApp('/admin/locutores')
    const toggle = await screen.findByRole('checkbox', { name: /Ligar a identificação por voz/ })
    expect(toggle).not.toBeChecked()
    expect(screen.getByLabelText('Semelhança mínima para sugerir (%)')).toHaveValue(75)
    await userEvent.click(toggle)
    const threshold = screen.getByLabelText('Semelhança mínima para sugerir (%)')
    await userEvent.clear(threshold)
    await userEvent.type(threshold, '62')
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByText('Configuração de voz salva.')).toBeInTheDocument()
    expect(await http.requests('PATCH /api/v1/admin/settings')[0].json()).toEqual({
      voice_identification: { enabled: true, suggestion_threshold: 0.62 },
    })
  })

  it('sem termo, trilha de auditoria nem purga', async () => {
    mockVoiceAdmin()
    renderApp('/admin/locutores')
    await screen.findByRole('checkbox', { name: /Ligar a identificação por voz/ })
    expect(screen.queryByLabelText('Texto que a pessoa aceita')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apagar todas as impressões' })).not.toBeInTheDocument()
  })
})
