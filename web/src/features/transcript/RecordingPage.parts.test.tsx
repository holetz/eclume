import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'
import { mockTranscriptApi, RECORDING_ID as RECORDING } from '../../test/transcriptApi'

beforeAll(() => preloadRoute('/gravacoes/x'))

afterEach(() => vi.unstubAllGlobals())

function audio() {
  return screen.getByLabelText('Áudio da gravação') as HTMLAudioElement
}

describe('player and markers', () => {
  it('plays and pauses through the player, which follows the audio', async () => {
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

  it('renews the expired signature once and resumes from the instant, playing; on the second failure, shows the error', async () => {
    const user = userEvent.setup()
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const player = await screen.findByRole('group', { name: 'Player' })
    const first = audio().getAttribute('src')
    fireEvent.loadedMetadata(audio())
    await user.click(within(player).getByRole('button', { name: 'Tocar' }))
    fireEvent.play(audio())
    fireEvent.playing(audio())
    audio().currentTime = 65
    fireEvent.timeUpdate(audio())
    vi.mocked(audio().play).mockClear()

    fireEvent.error(audio())
    expect(audio().getAttribute('src')).not.toBe(first)
    expect(audio().getAttribute('src')).toContain(`/api/v1/recordings/${RECORDING}/audio?`)
    audio().currentTime = 0
    fireEvent.loadedMetadata(audio())
    expect(audio().currentTime).toBe(65)
    expect(audio().play).toHaveBeenCalled()
    expect(screen.queryByText('O áudio não carregou.')).not.toBeInTheDocument()

    fireEvent.error(audio())
    // The notice sits right below the player, outside its row.
    const alert = screen.getByText('O áudio não carregou.').closest('[role="alert"]') as HTMLElement
    expect(within(player).getByRole('button', { name: 'Tocar' })).toBeDisabled()
    const failed = audio().getAttribute('src')
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }))
    expect(screen.queryByText('O áudio não carregou.')).not.toBeInTheDocument()
    expect(audio().getAttribute('src')).not.toBe(failed)
  })

  it('in a browser that does not play Ogg Opus, the player says so instead of staying silent', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const player = await screen.findByRole('group', { name: 'Player' })
    vi.spyOn(audio(), 'canPlayType').mockReturnValue('')
    fireEvent.error(audio())
    expect(screen.getByText(/^Este navegador não toca o áudio do eclume \(Ogg Opus\)/)).toHaveAttribute('role', 'alert')
    expect(within(player).getByRole('button', { name: 'Tocar' })).toBeDisabled()
  })

  it('seeks through the track and cycles the speed', async () => {
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

  it('one tick per marker at its position, and the chip plays from the marker', async () => {
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

  it('with no markers, the bar does not show and nothing is requested', async () => {
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

describe('audio deleted by retention', () => {
  it('replaces the player and the transcribe-again actions with the notice, without requesting the audio', async () => {
    mockTranscriptApi({
      'GET /api/v1/recordings/:id': () => ({
        ...fixtures.recordingTranscribed(),
        audio_deleted_at: '2026-10-20T03:50:00Z',
      }),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    expect(await screen.findByText(/O áudio desta gravação foi apagado pela política de retenção/)).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Player' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Áudio da gravação')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Transcrever de novo em…' })).not.toBeInTheDocument()
  })
})

describe('export', () => {
  it('a 401 on export ends the session like any other call', async () => {
    const user = userEvent.setup()
    let signedIn = true
    mockTranscriptApi({
      'GET /api/v1/me': () => (signedIn ? fixtures.me() : problem('unauthorized', 401)),
      'GET /api/v1/recordings/:id/export': () => {
        signedIn = false
        return problem('unauthorized', 401)
      },
    })
    renderApp(`/gravacoes/${RECORDING}`)
    await user.click(await screen.findByRole('button', { name: 'Exportar' }))
    await user.click(screen.getByRole('menuitem', { name: /Transcrição e resumo/ }))
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument()
  })
})

describe('transcribe again in…', () => {
  it('shows the language and retranscribes in another, with the confirmation of what changes', async () => {
    const user = userEvent.setup()
    const http = mockTranscriptApi({
      'POST /api/v1/recordings/:id/retranscribe': () => fixtures.recordingQueued(),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    expect(await screen.findByText(/· Português/)).toHaveClass('kicker')
    await user.click(screen.getByRole('button', { name: 'Transcrever de novo em…' }))
    const dialog = screen.getByRole('dialog', { name: 'Transcrever de novo?' })
    expect(dialog).toHaveTextContent('as correções de texto feitas à mão se perdem')
    const select = within(dialog).getByLabelText('Idioma')
    expect(select).toHaveValue('pt')
    await user.selectOptions(select, 'Inglês')
    await user.click(within(dialog).getByRole('button', { name: 'Transcrever de novo' }))
    await vi.waitFor(() => expect(http.requests('POST /api/v1/recordings/:id/retranscribe')).toHaveLength(1))
    expect(await http.requests('POST /api/v1/recordings/:id/retranscribe')[0].json()).toEqual({ language: 'en' })
  })

  it('carries the number of speakers when filled in', async () => {
    const user = userEvent.setup()
    const http = mockTranscriptApi({
      'POST /api/v1/recordings/:id/retranscribe': () => fixtures.recordingQueued(),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    await user.click(await screen.findByRole('button', { name: 'Transcrever de novo em…' }))
    const dialog = screen.getByRole('dialog', { name: 'Transcrever de novo?' })
    await user.type(within(dialog).getByLabelText('Mínimo de locutores'), '1')
    await user.type(within(dialog).getByLabelText('Máximo de locutores'), '2')
    await user.click(within(dialog).getByRole('button', { name: 'Transcrever de novo' }))
    await vi.waitFor(() => expect(http.requests('POST /api/v1/recordings/:id/retranscribe')).toHaveLength(1))
    expect(await http.requests('POST /api/v1/recordings/:id/retranscribe')[0].json()).toEqual({
      language: 'pt',
      min_speakers: 1,
      max_speakers: 2,
    })
  })

  it('the duplicate request says a transcription is already in progress', async () => {
    const user = userEvent.setup()
    mockTranscriptApi({
      'POST /api/v1/recordings/:id/retranscribe': () => problem('conflict', 409),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    await user.click(await screen.findByRole('button', { name: 'Transcrever de novo em…' }))
    const dialog = screen.getByRole('dialog', { name: 'Transcrever de novo?' })
    await user.click(within(dialog).getByRole('button', { name: 'Transcrever de novo' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Já há uma transcrição em andamento.')
  })
})
