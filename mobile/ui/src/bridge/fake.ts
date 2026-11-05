// The tests' fake bridge: keeps a scripted `AppState`, records the calls and lets the test swap the
// state (as the `estado` event would) and the replies of each command.

import { vi } from 'vitest'
import type { Bridge } from './bridge'
import type { AppSettings, AppState, LocalDetail, LocalRecording, Marker } from './types'

export function baseState(partial: Partial<AppState> = {}): AppState {
  return {
    conexao: {
      fase: 'conectado',
      servidor: { url: 'https://192.168.15.199:8443', nome: 'eclume', ca_sha256: 'ab'.repeat(32) },
    },
    rede: { estado: 'on_network' },
    sessao: null,
    folha: null,
    pendentes: 0,
    avisos: { armazenamento: null, bateria: null },
    espaco_livre: 'cerca de 9 h',
    versao: '0.1.0',
    ...partial,
  }
}

export function marker(at_ms: number, note: string | null = null): Marker {
  return { client_id: `m-${at_ms}`, recording_id: 'g1', at_ms, note, created_at: 0 }
}

export function localRecording(partial: Partial<LocalRecording> = {}): LocalRecording {
  return {
    id: 'g1',
    titulo: 'Reunião semanal',
    titulo_do_servidor: null,
    iniciada_em: new Date(2026, 8, 26, 9, 0).getTime(),
    duracao_ms: 54 * 60_000,
    bytes: 10_000_000,
    marcadores: 3,
    selo: 'sincronizada',
    remote_id: 'r1',
    apagada: false,
    tipo_de_agenda: 'Reunião de equipe',
    ultimo_erro: null,
    ...partial,
  }
}

export interface FakeBridge extends Bridge {
  /** Swaps the state and notifies the event's subscribers. */
  emit(state: AppState): void
  list: LocalRecording[]
  detail: LocalDetail | null
  config: AppSettings
}

export function fakeBridge(initial: AppState = baseState()): FakeBridge {
  let current = initial
  const listeners = new Set<(state: AppState) => void>()
  const bridge: FakeBridge = {
    list: [],
    detail: null,
    config: {
      servidor: 'https://192.168.15.199:8443',
      preferencias: { sync_auto: true, qualidade: 'padrao', excluir_sincronizadas: false },
      reter_dias: 7,
      uso_bytes: 1_200_000_000,
      versao: '0.1.0',
    },
    emit(state) {
      current = state
      listeners.forEach((listener) => listener(state))
    },
    state: vi.fn(async () => current),
    onState: vi.fn(async (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    }),
    discover: vi.fn(async () => []),
    connectDiscovered: vi.fn(async () => {}),
    connectAddress: vi.fn(async () => {}),
    trustCa: vi.fn(async () => {}),
    cancelCa: vi.fn(async () => {}),
    signIn: vi.fn(async () => {}),
    scanCode: vi.fn(async () => null),
    cancelScan: vi.fn(async () => {}),
    pair: vi.fn(async () => {}),
    permissions: vi.fn(async () => ({ microphone: true, notifications: true })),
    device: vi.fn(async () => ({ notifications: true, batteryExemption: 'concedida' as const })),
    openAppSettings: vi.fn(async () => {}),
    requestBatteryExemption: vi.fn(async () => {}),
    consumeShortcut: vi.fn(async () => false),
    record: vi.fn(async () => 'g1'),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    mark: vi.fn(async () => marker(1_000)),
    annotateMarker: vi.fn(async (clientId: string, note: string | null) => ({
      ...marker(1_000, note),
      client_id: clientId,
    })),
    stop: vi.fn(async () => 'g1'),
    save: vi.fn(async () => {}),
    syncNow: vi.fn(async () => {}),
    recordings: vi.fn(async () => bridge.list),
    recording: vi.fn(async () => {
      if (!bridge.detail) throw 'gravação g1 não está no celular'
      return bridge.detail
    }),
    fileUrl: (path) => `asset://localhost/${path}`,
    openOnWeb: vi.fn(async () => {}),
    deleteLocal: vi.fn(async () => {}),
    deleteSynced: vi.fn(async () => 1_100_000_000),
    agendaTypes: vi.fn(async () => [
      { id: 't1', nome: 'Reunião de equipe' },
      { id: 't2', nome: 'Visita ao cliente' },
    ]),
    languages: vi.fn(async () => [
      { valor: '', rotulo: 'Padrão da conta: Português' },
      { valor: 'auto', rotulo: 'Detectar automaticamente' },
      { valor: 'pt', rotulo: 'Português' },
      { valor: 'es', rotulo: 'Español' },
      { valor: 'en', rotulo: 'English' },
    ]),
    settings: vi.fn(async () => bridge.config),
    saveSettings: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    visibility: vi.fn(async () => {}),
    insets: vi.fn(async () => ({ top: 0, bottom: 0 })),
    checkUpdate: vi.fn(async () => null),
    update: vi.fn(async () => {}),
  }
  return bridge
}
