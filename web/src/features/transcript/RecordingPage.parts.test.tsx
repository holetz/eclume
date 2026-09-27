import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { renderApp } from '../../test/render'
import { mockTranscriptApi, RECORDING_ID as RECORDING } from '../../test/transcriptApi'

afterEach(() => vi.unstubAllGlobals())

function audio() {
  return screen.getByLabelText('Áudio da gravação') as HTMLAudioElement
}

describe('player e marcadores', () => {
  it('toca e pausa pelo player, que acompanha o áudio', async () => {
    const user = userEvent.setup()
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const player = await screen.findByRole('group', { name: 'Player' })
    expect(player).toHaveClass('player')
    expect(within(player).getByText('00:02:46')).toBeInTheDocument()

    await user.click(within(player).getByRole('button', { name: 'Tocar' }))
    expect(audio().play).toHaveBeenCalled()
    fireEvent.play(audio())
    expect(within(player).getByRole('button', { name: 'Pausar' })).toBeInTheDocument()

    audio().currentTime = 65
    fireEvent.timeUpdate(audio())
    expect(within(player).getByText('00:01:05')).toBeInTheDocument()
    expect(within(player).getByRole('slider', { name: 'Posição no áudio' })).toHaveAttribute(
      'aria-valuetext',
      '00:01:05',
    )
  })

  it('posiciona pela trilha e troca a velocidade em ciclo', async () => {
    const user = userEvent.setup()
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const slider = await screen.findByRole('slider', { name: 'Posição no áudio' })
    fireEvent.change(slider, { target: { value: '120000' } })
    expect(audio().currentTime).toBe(120)

    const speed = screen.getByRole('button', { name: 'Velocidade 1×' })
    await user.click(speed)
    expect(audio().playbackRate).toBe(1.25)
    await user.click(screen.getByRole('button', { name: 'Velocidade 1,25×' }))
    await user.click(screen.getByRole('button', { name: 'Velocidade 1,5×' }))
    await user.click(screen.getByRole('button', { name: 'Velocidade 2×' }))
    expect(screen.getByRole('button', { name: 'Velocidade 1×' })).toBeInTheDocument()
  })

  it('um tick por marcador na posição dele, e a ficha toca do marcador', async () => {
    const user = userEvent.setup()
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const tick = await screen.findByRole('button', { name: 'Marcador em 00:00:42: Decisão sobre as turmas' })
    expect(tick).toHaveClass('player-tick')
    expect(tick.style.getPropertyValue('--at')).toBe(`${(42_000 / 166_000) * 100}%`)
    const empty = screen.getByRole('button', { name: 'Marcador em 00:02:11' })

    const bar = screen.getByRole('group', { name: 'Marcadores' })
    expect(bar).toHaveClass('marker-bar')
    expect(bar).toHaveTextContent('Marcado no NB-MARIANA')
    const chips = within(bar).getAllByRole('button')
    expect(chips.map((chip) => chip.textContent)).toEqual(['00:00:42Decisão sobre as turmas', '00:02:11Marcador'])
    expect(chips[1]).toHaveAttribute('data-empty')

    await user.click(chips[0])
    expect(audio().currentTime).toBe(42)
    expect(audio().play).toHaveBeenCalled()
    fireEvent.timeUpdate(audio())
    expect(tick).toHaveAttribute('aria-current', 'true')

    await user.click(empty)
    expect(audio().currentTime).toBe(131.5)
  })

  it('sem marcadores, a barra não aparece e nada é pedido', async () => {
    const recording = fixtures.recordingTranscribed()
    recording.marker_count = 0
    const http = mockTranscriptApi({ 'GET /api/v1/recordings/:id': () => recording })
    renderApp(`/gravacoes/${RECORDING}`)
    await screen.findByRole('group', { name: 'Player' })
    expect(screen.queryByRole('group', { name: 'Marcadores' })).not.toBeInTheDocument()
    expect(document.querySelector('.player-tick')).toBeNull()
    expect(http.requests('GET /api/v1/recordings/:id/markers')).toHaveLength(0)
  })
})
