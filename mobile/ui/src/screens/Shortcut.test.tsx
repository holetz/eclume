import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../app/App'
import { baseState, marker, fakeBridge, type FakeBridge } from '../bridge/fake'
import { BridgeContext } from '../bridge/bridge'
import type { AppState } from '../bridge/types'

const SERVER = { url: 'https://192.168.15.199:8443', nome: 'eclume', ca_sha256: 'ab'.repeat(32) }

/** Opens the app with a pending tap on the record-now shortcut (consumed once). */
function openFromShortcut(state: AppState, route = '/', prepare?: (bridge: FakeBridge) => void) {
  window.location.hash = route
  const bridge = fakeBridge(state)
  let pending = true
  bridge.consumeShortcut = vi.fn(async () => {
    const record = pending
    pending = false
    return record
  })
  prepare?.(bridge)
  render(
    <BridgeContext.Provider value={bridge}>
      <App />
    </BridgeContext.Provider>,
  )
  return bridge
}

function returnToApp() {
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

describe('record-now shortcut', () => {
  beforeEach(() => {
    window.location.hash = '/'
  })

  it('connected and with no recording, records through the button flow, once', async () => {
    const bridge = openFromShortcut(baseState(), '/settings')
    await waitFor(() => expect(bridge.record).toHaveBeenCalledTimes(1))
    expect(bridge.permissions).toHaveBeenCalled()
    expect(window.location.hash).toBe('#/')
    // Returning to the app (recents, another Activity) does not record again.
    returnToApp()
    await waitFor(() => expect(bridge.consumeShortcut).toHaveBeenCalledTimes(2))
    expect(bridge.record).toHaveBeenCalledTimes(1)
  })

  it('without the microphone, stops and explains as the button does', async () => {
    const bridge = openFromShortcut(baseState(), '/', (p) => {
      p.permissions = vi.fn(async () => ({ microphone: false, notifications: true }))
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('Sem o microfone')
    expect(bridge.record).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Abrir configurações do app' })).toBeInTheDocument()
  })

  it('before the first record without the exemption, explains the battery', async () => {
    const bridge = openFromShortcut(baseState(), '/', (p) => {
      p.device = vi.fn(async () => ({ notifications: true, batteryExemption: 'pedir' as const }))
    })
    expect(await screen.findByRole('alertdialog', { name: 'Gravar com a tela bloqueada' })).toBeInTheDocument()
    expect(bridge.record).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Agora não' }))
    await waitFor(() => expect(bridge.record).toHaveBeenCalledTimes(1))
  })

  it('with a recording running, only shows its screen', async () => {
    const session = {
      id: 'g1',
      iniciada_em: Date.now(),
      audio_ms: 60_000,
      nivel: 0.2,
      pausada: false,
      marcadores: [marker(1_000)],
      microfone: 'ok' as const,
      silenciada: false,
    }
    const bridge = openFromShortcut(baseState({ sessao: session }))
    expect(await screen.findByText('Gravando')).toBeInTheDocument()
    await waitFor(() => expect(bridge.consumeShortcut).toHaveBeenCalled())
    expect(bridge.record).not.toHaveBeenCalled()
  })

  it('without a credential, drops the shortcut and shows the sign-in screen', async () => {
    const bridge = openFromShortcut(baseState({ conexao: { fase: 'sem_credencial', servidor: SERVER } }))
    await waitFor(() => expect(bridge.consumeShortcut).toHaveBeenCalled())
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument()
    expect(bridge.record).not.toHaveBeenCalled()
    // Signed in later: the tap was already dropped and does not record by itself.
    act(() => bridge.emit(baseState()))
    returnToApp()
    await waitFor(() => expect(bridge.consumeShortcut).toHaveBeenCalledTimes(2))
    expect(bridge.record).not.toHaveBeenCalled()
  })
})
