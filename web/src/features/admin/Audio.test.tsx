import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/admin/audio'))

afterEach(() => vi.unstubAllGlobals())

function mockAudioApi(extra: Parameters<typeof mockFetch>[0] = {}) {
  const settings = fixtures.adminSettings()
  return mockFetch({
    'GET /api/v1/admin/me': () => fixtures.adminMe(),
    'GET /api/v1/admin/settings': () => settings,
    'PATCH /api/v1/admin/settings': async (request) => ({
      ...settings,
      preprocessing: (await request.json()).preprocessing,
    }),
    ...extra,
  })
}

const sentBody = (http: ReturnType<typeof mockFetch>) => http.requests('PATCH /api/v1/admin/settings')[0].json()

describe('Pré-processamento de áudio', () => {
  it('mostra as cinco etapas na ordem do worker, com 16 kHz mono sempre ligada', async () => {
    mockAudioApi()
    renderApp('/admin/audio')
    const list = await screen.findByRole('list', { name: 'Etapas do pré-processamento' })
    expect(screen.getByRole('heading', { level: 1, name: 'Pré-processamento de áudio' })).toBeInTheDocument()
    const items = within(list).getAllByRole('listitem')
    expect(items.map((item) => item.querySelector('strong')!.textContent)).toEqual([
      'Separar canais estéreo',
      'Redução de ruído',
      'Normalização de loudness',
      'Converter para 16 kHz mono',
      'Cortar silêncio',
    ])
    expect(items.map((item) => item.querySelector('.order-num')!.textContent)).toEqual(['01', '02', '03', '04', '05'])
    expect(within(items[3]).getByText('Sempre ligada')).toBeInTheDocument()
    expect(within(items[3]).queryByRole('switch')).not.toBeInTheDocument()
    expect(within(items[1]).getByText('RNNoise · força 0,6')).toBeInTheDocument()
    expect(within(items[2]).getByText('Alvo -16 LUFS')).toBeInTheDocument()
    expect(within(items[4]).getByText('Mais de 3 s no início e no fim')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Separar canais estéreo' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Redução de ruído' })).toBeChecked()
    // A ordem é fixa: nenhuma alça de arrastar.
    expect(document.querySelector('.grip')).toBeNull()
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeDisabled()
  })

  it('ajusta as etapas e salva só o bloco preprocessing inteiro', async () => {
    const http = mockAudioApi()
    renderApp('/admin/audio')
    await userEvent.click(await screen.findByRole('switch', { name: 'Separar canais estéreo' }))
    const denoise = screen.getByRole('button', { name: 'Ajustes de redução de ruído' })
    expect(denoise).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(denoise)
    expect(denoise).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(screen.getByRole('radio', { name: 'afftdn' }))
    fireEvent.change(screen.getByLabelText(/^Força/), { target: { value: '0.35' } })
    expect(screen.getByText('afftdn · força 0,35')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Ajustes de normalização de loudness' }))
    const target = screen.getByLabelText('Alvo (LUFS)')
    await userEvent.clear(target)
    await userEvent.type(target, '-18')
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByText('Configuração salva.')).toBeInTheDocument()

    const sent = await sentBody(http)
    expect(Object.keys(sent)).toEqual(['preprocessing'])
    expect(sent.preprocessing).toEqual({
      split_channels: { enabled: true },
      denoise: { enabled: true, method: 'afftdn', strength: 0.35 },
      loudnorm: { enabled: true, target_lufs: -18, true_peak_db: -1.5, lra: 11 },
      trim_silence: { enabled: true, min_silence_s: 3, threshold_db: -50 },
    })
  })

  it('valor fora do limite marca o campo e trava o Salvar', async () => {
    mockAudioApi()
    renderApp('/admin/audio')
    await userEvent.click(await screen.findByRole('button', { name: 'Ajustes de cortar silêncio' }))
    const threshold = screen.getByLabelText('Limiar (dB)')
    await userEvent.clear(threshold)
    await userEvent.type(threshold, '-10')
    expect(threshold).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Entre -80 e -20.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeDisabled()
  })

  it('mostra o 422 do servidor no campo', async () => {
    mockAudioApi({
      'PATCH /api/v1/admin/settings': () =>
        problem('validation_failed', 422, {
          errors: [{ field: 'preprocessing.loudnorm.lra', message: 'fora da faixa aceita' }],
        }),
    })
    renderApp('/admin/audio')
    await userEvent.click(await screen.findByRole('switch', { name: 'Cortar silêncio' }))
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('preprocessing.loudnorm.lra')
    await userEvent.click(screen.getByRole('button', { name: 'Ajustes de normalização de loudness' }))
    expect(screen.getByLabelText('Faixa de loudness (LRA)')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('fora da faixa aceita')).toBeInTheDocument()
  })
})
