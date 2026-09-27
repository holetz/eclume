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
    'GET /api/v1/people/:id/voiceprint': () => fixtures.voiceprint(),
    ...extra,
  })
}

async function openSamples() {
  renderApp(`/pessoas/${RAFAEL}?aba=amostras`)
  return screen.findByRole('tabpanel')
}

describe('aba Amostras de voz', () => {
  it('lista as amostras com duração e data, sem aceite por pessoa nem exportação', async () => {
    mockVoice()
    const panel = await openSamples()
    const samples = await within(panel).findByRole('list', { name: 'Amostras de voz' })
    const rows = within(samples).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Alinhamento do programa de lideranças')
    expect(rows[0]).toHaveTextContent(/confirmada em 18 de set/)
    expect(within(samples).getByText('Gravação excluída')).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'Como funcionam as sugestões por voz' })).toHaveAttribute(
      'href',
      '/ajuda/sugestoes-por-voz',
    )
    // O aceite do aviso no cadastro substitui o termo de cada pessoa.
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /Exportar/ })).not.toBeInTheDocument()
  })

  it('ouve o trecho de uma amostra e remove só aquela amostra', async () => {
    const http = mockVoice({ 'DELETE /api/v1/people/:id/voice-samples/:tid/:sid': () => empty() })
    const panel = await openSamples()
    const samples = await within(panel).findByRole('list', { name: 'Amostras de voz' })
    const [first, deleted] = within(samples).getAllByRole('listitem')
    // Sem gravação não há trecho para ouvir, mas a amostra ainda sai da impressão.
    expect(within(deleted).queryByRole('button', { name: /Ouvir/ })).not.toBeInTheDocument()
    const play = within(first).getByRole('button', { name: 'Ouvir a amostra de Alinhamento do programa de lideranças' })
    await userEvent.click(play)
    expect(within(first).getByRole('button', { name: 'Pausar a amostra' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(within(first).getByRole('button', { name: 'Remover' }))
    expect(await screen.findByText('Amostra removida.')).toBeInTheDocument()
    expect(http.requests('DELETE /api/v1/people/:id/voice-samples/:tid/:sid')).toHaveLength(1)
  })

  it('esquece a voz com confirmação em diálogo', async () => {
    const http = mockVoice({ 'DELETE /api/v1/people/:id/voiceprint': () => empty() })
    const panel = await openSamples()
    await userEvent.click(await within(panel).findByRole('button', { name: 'Esquecer a voz' }))
    const dialog = screen.getByRole('dialog', { name: 'Esquecer a voz?' })
    expect(dialog).toHaveTextContent(
      'Apaga todas as amostras e as sugestões pendentes desta pessoa. Os vínculos já confirmados ficam.',
    )
    await userEvent.click(within(dialog).getByRole('button', { name: 'Esquecer a voz' }))
    expect(await screen.findByText('Voz esquecida.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(http.requests('DELETE /api/v1/people/:id/voiceprint')).toHaveLength(1)
  })

  it('avisa quando a identificação por voz está desligada', async () => {
    mockVoice({
      'GET /api/v1/people/:id/voiceprint': () => ({ ...fixtures.voiceprint(), enabled: false, sample_count: 0, samples: [] }),
    })
    const panel = await openSamples()
    expect(await within(panel).findByText(/identificação por voz está desligada/)).toBeInTheDocument()
    expect(within(panel).getByText('Nenhuma amostra de voz ainda.')).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Esquecer a voz' })).not.toBeInTheDocument()
  })
})
