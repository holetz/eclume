import { setLocale } from '../i18n'
import { duration, when, longDate, suggestedTitle, size, rate, markers } from '../app/formats'
import { errorMessage } from '../bridge/bridge'
import { act, render, screen, waitFor } from '@testing-library/react'
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


describe('English recording home', () => {
  beforeEach(() => {
    window.location.hash = '/'
  })

  it('shows the main controls and updates the list and badges on a locale switch', async () => {
    setLocale('en')
    openApp(baseState({ locale: 'en' }), (bridge) => {
      bridge.list = [localRecording({ titulo: null, marcadores: 1 })]
    })
    expect(await screen.findByRole('button', { name: /Record/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument()
    expect(await screen.findByText('Untitled')).toBeInTheDocument()
    expect(screen.getByText('Uploaded')).toBeInTheDocument()
    expect(screen.getByText(/54 min · 1 marker$/)).toBeInTheDocument()
    act(() => setLocale('pt-BR'))
    expect(screen.getByRole('button', { name: /Gravar/ })).toBeInTheDocument()
    expect(screen.getByText('Enviada')).toBeInTheDocument()
  })

  it('explains missing microphone access in English', async () => {
    setLocale('en')
    openApp(baseState({ locale: 'en' }), (bridge) => {
      bridge.permissions = async () => ({ microphone: false, notifications: true })
    })
    await userEvent.click(await screen.findByRole('button', { name: /Record/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Without microphone access, eclume cannot record.')
    expect(screen.getByRole('button', { name: 'Open app settings' })).toBeInTheDocument()
  })
})

describe('localized recording formats', () => {
  const timestamp = new Date(2026, 8, 26, 9).getTime()

  it('uses consistent English dates, counts and numbers', () => {
    setLocale('en')
    expect(duration(0)).toBe('less than 1 min')
    expect(duration(null)).toBe('—')
    expect(duration(72 * 60_000)).toBe('1 h 12 min')
    expect(when(timestamp, new Date(2026, 8, 26, 12))).toBe('Today 09:00')
    expect(when(timestamp, new Date(2026, 8, 27, 12))).toBe('Yesterday 09:00')
    expect(when(timestamp, new Date(2026, 9, 1))).toBe('Sep 26 09:00')
    expect(longDate(timestamp)).toBe('Sat Sep 26 2026 · 09:00')
    expect(suggestedTitle(timestamp)).toBe('Sat Sep 26, 09:00')
    expect(size(1_100_000_000)).toBe('1.1 GB')
    expect(size(1_200_000)).toBe('1 MB')
    expect(rate(18_000_000)).toBe('18 MB/s')
    expect(rate(640_000)).toBe('640 kB/s')
    expect([0, 1, 2].map(markers)).toEqual(['0 markers', '1 marker', '2 markers'])
    expect(errorMessage(null)).toBe('Something went wrong. Try again.')
  })

  it('preserves the exact Portuguese formats, including zero markers', () => {
    expect(duration(0)).toBe('menos de 1 min')
    expect(when(timestamp, new Date(2026, 8, 26, 12))).toBe('Hoje 09:00')
    expect(when(timestamp, new Date(2026, 8, 27, 12))).toBe('Ontem 09:00')
    expect(when(timestamp, new Date(2026, 9, 1))).toBe('26 set 09:00')
    expect(longDate(timestamp)).toBe('sáb 26 set 2026 · 09:00')
    expect(suggestedTitle(timestamp)).toBe('sáb 26 set, 09:00')
    expect(size(1_100_000_000)).toBe('1,1 GB')
    expect([0, 1, 2].map(markers)).toEqual(['0 marcadores', '1 marcador', '2 marcadores'])
    expect(errorMessage(null)).toBe('Algo deu errado. Tente de novo.')
  })
})
