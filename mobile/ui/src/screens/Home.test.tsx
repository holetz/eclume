import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import App from '../app/App'
import { baseState, localRecording, fakeBridge, type FakeBridge } from '../bridge/fake'
import { BridgeContext } from '../bridge/bridge'
import type { AppState } from '../bridge/types'

function openApp(state: AppState, prepare?: (bridge: FakeBridge) => void) {
  const bridge = fakeBridge(state)
  prepare?.(bridge)
  render(
    <BridgeContext.Provider value={bridge}>
      <App />
    </BridgeContext.Provider>,
  )
  return bridge
}

describe('home', () => {
  beforeEach(() => {
    window.location.hash = '/'
  })

  it('on the eclume network, syncs now and lists the phone', async () => {
    const bridge = openApp(baseState(), (p) => {
      p.list = [
        localRecording(),
        localRecording({ id: 'g2', titulo: null, marcadores: 0, selo: 'aguardando', duracao_ms: 22 * 60_000 }),
      ]
    })
    expect(await screen.findByText('Na rede do eclume')).toBeInTheDocument()
    expect(await screen.findByText('Reunião semanal')).toBeInTheDocument()
    expect(screen.getByText('Sem título')).toBeInTheDocument()
    expect(screen.getByText(/54 min · 3 marcadores$/)).toBeInTheDocument()
    expect(screen.getByText('Enviada')).toHaveClass('badge-success')
    expect(screen.getByText('Aguardando envio')).toBeInTheDocument()
    expect(screen.getByText('Tudo sincronizado')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sincronizar agora' }))
    expect(bridge.syncNow).toHaveBeenCalled()
  })

  it('off the network, shows how many wait and that it syncs on the server Wi-Fi', async () => {
    openApp(baseState({ rede: { estado: 'away' }, pendentes: 2 }))
    expect(await screen.findByText('Fora da rede do eclume')).toBeInTheDocument()
    expect(screen.getByText('2 aguardando')).toBeInTheDocument()
    expect(screen.getByText('Sincroniza no Wi‑Fi do servidor')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sincronizar agora' })).not.toBeInTheDocument()
  })

  it('while syncing, shows the progress', async () => {
    openApp(baseState({ rede: { estado: 'syncing', i: 1, n: 2, pct: 64, bytes_s: 18_000_000 }, pendentes: 2 }))
    expect(await screen.findByText('Sincronizando 1 de 2')).toBeInTheDocument()
    expect(screen.getByText('64 % · 18 MB/s')).toBeInTheDocument()
    expect(screen.getByLabelText('Andamento do envio')).toHaveAttribute('value', '64')
  })

  it('records after asking for the microphone', async () => {
    const bridge = openApp(baseState())
    await userEvent.click(await screen.findByRole('button', { name: /Gravar/ }))
    expect(bridge.permissions).toHaveBeenCalled()
    expect(bridge.record).toHaveBeenCalled()
  })

  it('without the microphone, does not record, explains and opens the app settings', async () => {
    const bridge = openApp(baseState(), (p) => {
      p.permissions = async () => ({ microphone: false, notifications: true })
    })
    await userEvent.click(await screen.findByRole('button', { name: /Gravar/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Sem o microfone')
    expect(bridge.record).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Abrir configurações do app' }))
    expect(bridge.openAppSettings).toHaveBeenCalled()
  })

  it('with the notifications blocked, shows the banner with the shortcut', async () => {
    const bridge = openApp(baseState(), (p) => {
      p.device = async () => ({ notifications: false, batteryExemption: 'concedida' })
    })
    expect(await screen.findByText('Notificações bloqueadas')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Abrir configurações do app' }))
    expect(bridge.openAppSettings).toHaveBeenCalled()
  })

  it('explains the battery before the first record and asks for the exemption', async () => {
    const bridge = openApp(baseState(), (p) => {
      p.device = async () => ({ notifications: true, batteryExemption: 'pedir' })
    })
    await waitFor(() => expect(bridge.device).toBeDefined())
    await userEvent.click(await screen.findByRole('button', { name: /Gravar/ }))
    expect(await screen.findByRole('alertdialog', { name: 'Gravar com a tela bloqueada' })).toBeInTheDocument()
    expect(bridge.record).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Permitir' }))
    expect(bridge.requestBatteryExemption).toHaveBeenCalled()
    await waitFor(() => expect(bridge.record).toHaveBeenCalled())
  })

  it('with little space, warns and deletes the synced ones', async () => {
    const bridge = openApp(
      baseState({
        avisos: {
          armazenamento: { restante: 'cerca de 40 min', sincronizadas_bytes: 1_100_000_000 },
          bateria: null,
        },
      }),
    )
    expect(await screen.findByText('Armazenamento quase cheio')).toBeInTheDocument()
    expect(screen.getByText('Cerca de 40 min de gravação.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Excluir sincronizadas · 1,1 GB' }))
    await waitFor(() => expect(bridge.deleteSynced).toHaveBeenCalled())
  })

  it('opens the settings and the detail', async () => {
    openApp(baseState(), (p) => {
      p.list = [localRecording()]
    })
    await userEvent.click(await screen.findByText('Reunião semanal'))
    expect(window.location.hash).toBe('#/recording/g1')
  })
})
