import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'
import { mockTranscriptApi, RECORDING_ID as RECORDING } from '../../test/transcriptApi'

afterEach(() => vi.unstubAllGlobals())

describe('página da gravação', () => {
  it('mostra as falas com locutor e tempo, e o player do áudio', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    expect(await screen.findByRole('heading', { name: 'Alinhamento do programa de lideranças' })).toBeInTheDocument()
    const falas = await screen.findByRole('list', { name: 'Falas' })
    const items = within(falas).getAllByRole('listitem')
    expect(items).toHaveLength(12)
    expect(within(items[0]).getByText('Mariana Couto')).toBeInTheDocument()
    expect(within(items[1]).getByText('Locutor 2')).toBeInTheDocument()
    expect(within(items[0]).getByRole('button', { name: /Ouvir a partir de 00:03/ })).toBeInTheDocument()
    const audio = screen.getByLabelText('Áudio da gravação') as HTMLAudioElement
    expect(audio.getAttribute('src')).toBe(`/api/v1/recordings/${RECORDING}/audio`)
  })

  it('clicar num segmento posiciona e toca o player e destaca a fala', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const falas = await screen.findByRole('list', { name: 'Falas' })
    const items = within(falas).getAllByRole('listitem')
    const audio = screen.getByLabelText('Áudio da gravação') as HTMLAudioElement

    await userEvent.click(items[3].querySelector('p')!)
    expect(audio.currentTime).toBe(39.5)
    expect(audio.play).toHaveBeenCalled()
    expect(items[3]).toHaveAttribute('aria-current', 'true')

    await userEvent.click(within(items[6]).getByRole('button', { name: /Ouvir a partir de 01:20/ }))
    expect(audio.currentTime).toBe(80.9)
    expect(items[6]).toHaveAttribute('aria-current', 'true')
    expect(items[3]).not.toHaveAttribute('aria-current')
  })

  it('o destaque acompanha o tempo do player', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const falas = await screen.findByRole('list', { name: 'Falas' })
    const items = within(falas).getAllByRole('listitem')
    const audio = screen.getByLabelText('Áudio da gravação') as HTMLAudioElement
    audio.currentTime = 100
    fireEvent.timeUpdate(audio)
    expect(items[7]).toHaveAttribute('aria-current', 'true')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('gravação ainda em processamento mostra o job no lugar da transcrição', async () => {
    const page = fixtures.recordingPage()
    mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/recordings/:id': () => page.items[0],
    })
    renderApp('/gravacoes/01928f3a-1c00-7a00-8000-000000000402')
    expect(await screen.findByText('Separando locutores')).toBeInTheDocument()
    expect(screen.getByText(/aparece aqui assim que o processamento terminar/)).toBeInTheDocument()
  })
})
