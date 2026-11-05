import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../app/App'
import { followSystemTheme } from '../app/theme'
import { baseState, localRecording, marker, fakeBridge, type FakeBridge } from '../bridge/fake'
import { BridgeContext } from '../bridge/bridge'

function openApp(route: string, prepare?: (bridge: FakeBridge) => void) {
  window.location.hash = route
  const bridge = fakeBridge(baseState({ pendentes: 2 }))
  prepare?.(bridge)
  render(
    <BridgeContext.Provider value={bridge}>
      <App />
    </BridgeContext.Provider>,
  )
  return bridge
}

describe('recording detail', () => {
  it('plays the local file and shows the markers and the steps on the server', async () => {
    const bridge = openApp('/recording/g1', (p) => {
      p.detail = {
        gravacao: localRecording({ bytes: 10_000_000, duracao_ms: 54 * 60_000 }),
        caminho: '/data/eclume/gravacoes/g1.ogg',
        marcadores: [marker(4 * 60_000 + 2_000, 'Início da pauta'), marker(41 * 60_000 + 18_000)],
        etapas: [
          { step: 'received', state: 'done' },
          { step: 'preprocessing', state: 'done' },
          { step: 'transcription', state: 'done' },
          { step: 'fields', state: 'active' },
          { step: 'agenda_type', state: 'skipped', reason: 'set_by_user' },
          { step: 'summary', state: 'pending' },
        ],
        endereco_na_web: 'https://192.0.2.10:8443/gravacoes/r1',
      }
    })
    expect(await screen.findByRole('heading', { name: 'Reunião semanal' })).toBeInTheDocument()
    expect(screen.getByText('Enviada')).toHaveClass('badge-success')
    expect(document.querySelector('audio')).toHaveAttribute('src', 'asset://localhost//data/eclume/gravacoes/g1.ogg')
    expect(screen.getByText('Início da pauta')).toBeInTheDocument()
    // The seven steps in the server's order, with the state in words and the reason visible under the bar.
    const steps = within(screen.getByRole('list', { name: 'Etapas no servidor' })).getAllByRole('listitem')
    expect(steps.map((step) => step.textContent)).toEqual([
      'Áudio recebido',
      'Pré-processamento',
      'Transcrição',
      'Locutores',
      'Tipo de agenda · pulada',
      'Preenchendo campos',
      'Resumo · esperando',
    ])
    expect(steps[5]).toHaveAttribute('data-state', 'active')
    expect(steps[6]).not.toHaveAttribute('data-state')
    expect(within(screen.getByRole('list', { name: 'Motivos das etapas' })).getByRole('listitem')).toHaveTextContent(
      'Tipo de agenda · pulada: o tipo foi escolhido por você',
    )
    expect(screen.getByText('54 min · 10 MB · Opus 25 kbps · Reunião de equipe')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Excluir deste celular' }))
    expect(bridge.deleteLocal).toHaveBeenCalledWith('g1')
    expect(screen.getByText('O servidor mantém a cópia dele.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Abrir na web' }))
    expect(bridge.openOnWeb).toHaveBeenCalledWith('g1')
  })

  it('stopped waiting for the speaker names, says it waits for you and why', async () => {
    openApp('/recording/g1', (p) => {
      p.detail = {
        gravacao: localRecording(),
        caminho: null,
        marcadores: [],
        etapas: [
          { step: 'received', state: 'done' },
          { step: 'preprocessing', state: 'done' },
          { step: 'transcription', state: 'done' },
          { step: 'speakers', state: 'waiting', reason: 'unnamed_speakers' },
          { step: 'agenda_type', state: 'pending' },
          { step: 'fields', state: 'pending' },
          { step: 'summary', state: 'pending' },
        ],
        endereco_na_web: 'https://192.0.2.10:8443/gravacoes/r1',
      }
    })
    const steps = within(await screen.findByRole('list', { name: 'Etapas no servidor' })).getAllByRole('listitem')
    expect(steps[3]).toHaveTextContent('Locutores · aguardando você')
    expect(steps[3]).toHaveAttribute('data-state', 'waiting')
    expect(within(screen.getByRole('list', { name: 'Motivos das etapas' })).getByRole('listitem')).toHaveTextContent(
      'Locutores · aguardando você: há locutores sem pessoa; nomeie todos para seguir com o tipo, os campos e o resumo',
    )
  })

  it('without a title given on stop, shows the one the server gave', async () => {
    openApp('/recording/g1', (p) => {
      p.detail = {
        gravacao: localRecording({ titulo: null, titulo_do_servidor: '2026-09-26 09-00 gravação' }),
        caminho: null,
        marcadores: [],
        etapas: [],
        endereco_na_web: 'https://192.0.2.10:8443/gravacoes/r1',
      }
    })
    expect(await screen.findByRole('heading', { name: '2026-09-26 09-00 gravação' })).toBeInTheDocument()
  })

  it('in the server queue, says why the transcription waits', async () => {
    openApp('/recording/g1', (p) => {
      p.detail = {
        gravacao: localRecording(),
        caminho: '/data/eclume/gravacoes/g1.ogg',
        marcadores: [],
        etapas: [{ step: 'received', state: 'done' }],
        espera: {
          reason: 'account_turn',
          ahead: null,
          account_ahead: 1,
          estimated_start_at: null,
          resumes_at: null,
          processor: { online: true, offline_since: null },
        },
        endereco_na_web: null,
      }
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Atrás de 1 gravação sua que chegou antes.')
  })

  it('while pending, offers no delete and does not show the server', async () => {
    openApp('/recording/g1', (p) => {
      p.detail = {
        gravacao: localRecording({ selo: 'aguardando', remote_id: null }),
        caminho: '/data/eclume/gravacoes/g1.ogg',
        marcadores: [],
        etapas: null,
        endereco_na_web: null,
      }
    })
    expect(await screen.findByText('Aguardando envio')).toBeInTheDocument()
    expect(screen.queryByText('No servidor')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Excluir deste celular' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Abrir na web' })).not.toBeInTheDocument()
  })
})

describe('settings', () => {
  it('changes the sync, the quality and the retention', async () => {
    const bridge = openApp('/settings')
    expect(await screen.findByText('192.0.2.10:8443')).toBeInTheDocument()
    expect(screen.getByText('Cerca de 11 MB por hora')).toBeInTheDocument()
    expect(screen.getByText('1,2 GB · 9 h livres')).toBeInTheDocument()
    expect(screen.getByLabelText('Só no Wi‑Fi do servidor')).toBeDisabled()
    await userEvent.click(screen.getByLabelText('Sincronizar automaticamente'))
    expect(bridge.saveSettings).toHaveBeenLastCalledWith({
      sync_auto: false,
      qualidade: 'padrao',
      excluir_sincronizadas: false,
    })
    await userEvent.click(screen.getByLabelText('Alta'))
    expect(await screen.findByText('Cerca de 22 MB por hora')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Excluir depois de sincronizar'))
    expect(bridge.saveSettings).toHaveBeenLastCalledWith({
      sync_auto: false,
      qualidade: 'alta',
      excluir_sincronizadas: true,
    })
    expect(screen.getByText('eclume para Android · v0.1.0')).toBeInTheDocument()
  })

  it('shows the battery-optimization exemption and asks for it when missing', async () => {
    const bridge = openApp('/settings', (p) => {
      p.device = vi.fn(async () => ({ notifications: true, batteryExemption: 'recusada' as const }))
    })
    expect(await screen.findByText('A otimização de bateria pode parar a gravação')).toBeInTheDocument()
    bridge.device = vi.fn(async () => ({ notifications: true, batteryExemption: 'concedida' as const }))
    await userEvent.click(screen.getByRole('button', { name: 'Permitir' }))
    expect(bridge.requestBatteryExemption).toHaveBeenCalled()
    expect(await screen.findByText('Sem otimização de bateria')).toBeInTheDocument()
  })

  it('sign out confirms and reminds of the pending recordings and of unlinking on the web', async () => {
    const bridge = openApp('/settings')
    await userEvent.click(await screen.findByRole('button', { name: 'Sair e esquecer o servidor' }))
    expect(await screen.findByText(/2 gravações aguardam o sync/)).toBeInTheDocument()
    expect(screen.getByText(/Desvincule este aparelho na web/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sair' }))
    await waitFor(() => expect(bridge.signOut).toHaveBeenCalled())
  })

  it('offers the new version from movel.json', async () => {
    const bridge = openApp('/settings', (p) => {
      p.checkUpdate = async () => ({ versao: '0.2.0', notas: null })
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Nova versão disponível · v0.2.0' }))
    expect(bridge.update).toHaveBeenCalled()
  })
})

describe('theme', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('follows the system theme', () => {
    const listeners: ((e: { matches: boolean }) => void)[] = []
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: (_: string, f: (e: { matches: boolean }) => void) => listeners.push(f),
      removeEventListener: () => {},
    }))
    const stop = followSystemTheme()
    expect(document.documentElement.dataset.theme).toBe('dark')
    listeners[0]({ matches: false })
    expect(document.documentElement.dataset.theme).toBe('light')
    stop()
  })
})
