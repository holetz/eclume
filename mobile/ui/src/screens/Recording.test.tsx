import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from '../app/App'
import { baseState, marker, fakeBridge } from '../bridge/fake'
import { BridgeContext } from '../bridge/bridge'
import type { AppState, SessionState } from '../bridge/types'

function session(partial: Partial<SessionState> = {}): SessionState {
  return {
    id: 'g1',
    iniciada_em: Date.now(),
    audio_ms: 42 * 60_000 + 10_000,
    nivel: 0.2,
    pausada: false,
    marcadores: [marker(12 * 60_000 + 40_000, 'Decisão do orçamento'), marker(31 * 60_000 + 5_000)],
    microfone: 'ok',
    silenciada: false,
    ...partial,
  }
}

function openApp(state: AppState) {
  window.location.hash = '/'
  const bridge = fakeBridge(state)
  render(
    <BridgeContext.Provider value={bridge}>
      <App />
    </BridgeContext.Provider>,
  )
  return bridge
}

describe('recording', () => {
  it('shows the audio time and the markers, and pauses', async () => {
    const bridge = openApp(baseState({ sessao: session() }))
    expect(await screen.findByText('Gravando')).toBeInTheDocument()
    expect(screen.getByLabelText('Tempo de áudio')).toHaveTextContent('00:42:10')
    expect(screen.getByText('Espaço livre: cerca de 9 h')).toBeInTheDocument()
    expect(screen.getByText('Decisão do orçamento')).toBeInTheDocument()
    expect(screen.getByText('00:31:05')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Pausar' }))
    expect(bridge.pause).toHaveBeenCalled()

    act(() => bridge.emit(baseState({ sessao: session({ pausada: true }) })))
    expect(await screen.findByText('Pausado')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(bridge.resume).toHaveBeenCalled()
  })

  it('marks right away and the note is optional', async () => {
    const bridge = openApp(baseState({ sessao: session() }))
    bridge.mark = async () => marker(42 * 60_000 + 10_000)
    await userEvent.click(await screen.findByRole('button', { name: 'Marcador' }))
    expect(await screen.findByLabelText('Marcador em 00:42:10')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Marcador em 00:42:10'), 'Tanaka entra')
    await userEvent.click(screen.getByRole('button', { name: 'Adicionar' }))
    expect(bridge.annotateMarker).toHaveBeenCalledWith(`m-${42 * 60_000 + 10_000}`, 'Tanaka entra')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Adicionar' })).not.toBeInTheDocument())
  })

  it('warns of the reconnecting microphone and of the silence the system imposes', async () => {
    const bridge = openApp(baseState({ sessao: session() }))
    expect(await screen.findByText('Gravando')).toBeInTheDocument()
    expect(screen.queryByText('Microfone reconectando')).not.toBeInTheDocument()

    act(() => bridge.emit(baseState({ sessao: session({ microfone: 'reconectando' }) })))
    expect(await screen.findByText('Microfone reconectando')).toBeInTheDocument()

    act(() => bridge.emit(baseState({ sessao: session({ microfone: 'reconectando', silenciada: true }) })))
    expect(await screen.findByText('Silenciado pelo sistema')).toBeInTheDocument()
    expect(screen.queryByText('Microfone reconectando')).not.toBeInTheDocument()

    act(() => bridge.emit(baseState({ sessao: session() })))
    await waitFor(() => expect(screen.queryByText('Silenciado pelo sistema')).not.toBeInTheDocument())
  })

  it('without a credential mid-recording, keeps recording and asks to sign in again', async () => {
    const server = { url: 'https://192.0.2.10:8443', nome: 'eclume', ca_sha256: 'ab'.repeat(32) }
    const bridge = openApp(baseState({ sessao: session(), conexao: { fase: 'sem_credencial', servidor: server } }))
    expect(await screen.findByText('Entre de novo para sincronizar')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pausar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Marcador' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Parar' }))
    expect(bridge.stop).toHaveBeenCalled()
  })

  it('warns of the low battery', async () => {
    openApp(
      baseState({
        sessao: session(),
        avisos: { armazenamento: null, bateria: { pct: 12, restante: 'cerca de 50 min' } },
      }),
    )
    expect(await screen.findByText('Bateria em 12 %')).toBeInTheDocument()
    expect(screen.getByText(/Dá para cerca de 50 min\. A gravação fica salva se o celular desligar\./)).toBeInTheDocument()
  })

  it('stops, and the sheet saves the title, agenda type and language, or skips', async () => {
    const bridge = openApp(baseState({ sessao: session() }))
    await userEvent.click(await screen.findByRole('button', { name: 'Parar' }))
    expect(bridge.stop).toHaveBeenCalled()

    const sheet = { id: 'g1', iniciada_em: new Date(2026, 8, 26, 10, 42).getTime(), duracao_ms: 72 * 60_000, marcadores: 2 }
    act(() => bridge.emit(baseState({ folha: sheet })))
    expect(await screen.findByRole('heading', { name: 'Gravação salva' })).toBeInTheDocument()
    expect(screen.getByText('1 h 12 min · 2 marcadores · neste celular')).toBeInTheDocument()
    expect(screen.getByLabelText('Título (opcional)')).toHaveAttribute('placeholder', 'sáb 26 set, 10:42')
    await userEvent.type(screen.getByLabelText('Título (opcional)'), 'Visita ao cliente')
    await userEvent.click(await screen.findByRole('button', { name: 'Visita ao cliente' }))
    const language = await screen.findByLabelText('Idioma da transcrição')
    expect(language).toHaveValue('')
    expect(within(language).getByRole('option', { name: 'Padrão da conta: Português' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(bridge.save).toHaveBeenCalledWith('g1', 'Visita ao cliente', 't2', null)

    await userEvent.selectOptions(language, 'Detectar automaticamente')
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(bridge.save).toHaveBeenLastCalledWith('g1', 'Visita ao cliente', 't2', 'auto')

    await userEvent.click(screen.getByRole('button', { name: 'Pular' }))
    expect(bridge.save).toHaveBeenLastCalledWith('g1', null, null, null)
  })
})
