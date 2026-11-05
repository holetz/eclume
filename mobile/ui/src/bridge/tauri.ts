// The real bridge: the app's commands (`invoke('<command>')`) and the native plugin's
// (`invoke('plugin:eclume-gravador|<command>')`), plus the official plugin's QR reader. The command
// names, argument keys and the plugin's JSON keys are the IPC contract and keep their names.

import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { cancel, Format, scan } from '@tauri-apps/plugin-barcode-scanner'
import type { Bridge } from './bridge'
import type { AppState, BatteryExemption } from './types'

/** The plugin's `estadoDoDispositivo` reply, in its wire keys. */
interface DeviceReply {
  notificacoes: boolean
  isencaoDeBateria: BatteryExemption
  insetTopo: number
  insetBase: number
}

export const tauriBridge: Bridge = {
  reportDeviceLocale: (tag) => invoke('report_device_locale', { tag }),
  state: () => invoke('estado'),
  async onState(onChange) {
    return listen<AppState>('estado', (event) => onChange(event.payload))
  },
  discover: (seconds) => invoke('descobrir', { segundos: seconds }),
  connectDiscovered: (url, ca) => invoke('conectar_descoberto', { url, ca }),
  connectAddress: (address) => invoke('conectar_endereco', { endereco: address }),
  trustCa: () => invoke('confiar_ca'),
  cancelCa: () => invoke('cancelar_ca'),
  signIn: (email, password) => invoke('entrar', { email, senha: password }),
  async scanCode() {
    try {
      const read = await scan({ windowed: true, formats: [Format.QRCode] })
      return read.content
    } catch {
      return null
    }
  },
  cancelScan: () => cancel(),
  pair: (text) => invoke('parear', { texto: text }),
  async permissions() {
    const states = await invoke<Record<string, string>>('plugin:eclume-gravador|request_permissions', {
      permissions: ['microfone', 'notificacoes'],
    })
    return { microphone: states.microfone === 'granted', notifications: states.notificacoes === 'granted' }
  },
  async device() {
    const device = await invoke<DeviceReply>('plugin:eclume-gravador|estado_do_dispositivo')
    return { notifications: device.notificacoes, batteryExemption: device.isencaoDeBateria }
  },
  openAppSettings: () => invoke('plugin:eclume-gravador|abrir_configuracoes_do_app'),
  requestBatteryExemption: () => invoke('plugin:eclume-gravador|pedir_isencao_de_bateria'),
  async consumeShortcut() {
    const shortcut = await invoke<{ gravar: boolean }>('plugin:eclume-gravador|consumir_atalho')
    return shortcut.gravar
  },
  record: () => invoke('gravar'),
  pause: () => invoke('pausar'),
  resume: () => invoke('continuar'),
  mark: (note) => invoke('marcar', { nota: note ?? null }),
  annotateMarker: (clientId, note) => invoke('anotar_marcador', { clientId, nota: note }),
  stop: () => invoke('parar'),
  save: (id, title, agendaTypeId, language) =>
    invoke('salvar', { id, titulo: title, tipoDeAgendaId: agendaTypeId, idioma: language }),
  syncNow: () => invoke('sincronizar_agora'),
  recordings: () => invoke('gravacoes'),
  recording: (id) => invoke('gravacao', { id }),
  fileUrl: (path) => convertFileSrc(path),
  openOnWeb: (id) => invoke('abrir_na_web', { id }),
  deleteLocal: (id) => invoke('excluir_local', { id }),
  deleteSynced: () => invoke('excluir_sincronizadas'),
  agendaTypes: () => invoke('tipos_de_agenda'),
  languages: () => invoke('idiomas'),
  settings: () => invoke('configuracoes'),
  saveSettings: (preferences) => invoke('salvar_configuracoes', { preferencias: preferences }),
  signOut: () => invoke('sair'),
  visibility: (visible) => invoke('visibilidade', { visivel: visible }),
  async insets() {
    const device = await invoke<DeviceReply>('plugin:eclume-gravador|estado_do_dispositivo')
    return { top: device.insetTopo, bottom: device.insetBase }
  },
  checkUpdate: () => invoke('verificar_atualizacao'),
  update: () => invoke('atualizar'),
}
