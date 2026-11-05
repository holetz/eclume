// The types the Rust core serializes (eclume-mobile-core); the UI is a function of the `AppState`.
// The field names are the core's wire format and keep their (pt-BR) names.

import type { Locale } from '../i18n'
import type { FilaDaEspera } from '../app/vocabulario.js'

export interface Server {
  url: string
  nome: string
  ca_sha256: string
}

export type ConnectionState =
  | { fase: 'sem_servidor' }
  | { fase: 'confirmar_ca'; url: string; impressao: string }
  | { fase: 'sem_credencial'; servidor: Server; motivo?: string }
  | { fase: 'conectado'; servidor: Server }

export type NetworkState =
  | { estado: 'away' }
  | { estado: 'on_network' }
  | { estado: 'syncing'; i: number; n: number; pct: number; bytes_s: number }
  | { estado: 'ca_mismatch' }
  | { estado: 'sem_credencial' }

export interface Marker {
  client_id: string
  recording_id: string
  at_ms: number
  note: string | null
  created_at: number
}

/** `reconectando`: the microphone dropped and the core tries to reopen it; the file gets silence. */
export type MicState = 'ok' | 'reconectando'

export interface SessionState {
  id: string
  iniciada_em: number
  audio_ms: number
  nivel: number
  pausada: boolean
  marcadores: Marker[]
  microfone: MicState
  /** The system silenced the capture (a call, the voice assistant, the microphone block). */
  silenciada: boolean
}

/** What the UI asks before recording: the microphone (required) and the notifications. */
export interface Permissions {
  microphone: boolean
  notifications: boolean
}

/** The battery-optimization exemption: `pedir` before the first time, `recusada` after. */
export type BatteryExemption = 'concedida' | 'pedir' | 'recusada'

/** What the device says about the permissions that live in the system settings. */
export interface DeviceStatus {
  notifications: boolean
  batteryExemption: BatteryExemption
}

export interface Sheet {
  id: string
  iniciada_em: number
  duracao_ms: number
  marcadores: number
}

export interface Warnings {
  armazenamento: { restante: string; sincronizadas_bytes: number } | null
  bateria: { pct: number; restante: string | null } | null
}

export interface AppState {
  locale: Locale
  conexao: ConnectionState
  rede: NetworkState
  sessao: SessionState | null
  folha: Sheet | null
  pendentes: number
  avisos: Warnings
  espaco_livre: string | null
  versao: string
}

export type Badge = 'gravando' | 'aguardando' | 'sincronizando' | 'sincronizada' | 'interrompida' | 'falhou'

export interface LocalRecording {
  id: string
  titulo: string | null
  /** The title the server gave after processing; the list shows it when there is no local title. */
  titulo_do_servidor: string | null
  iniciada_em: number
  duracao_ms: number | null
  bytes: number | null
  marcadores: number
  selo: Badge
  remote_id: string | null
  apagada: boolean
  tipo_de_agenda: string | null
  ultimo_erro: string | null
}

export interface Step {
  step: string
  /** `waiting` belongs only to the `speakers` step: the recording waits for the owner to name the speakers (contract 2.22.0). */
  state: 'pending' | 'active' | 'done' | 'failed' | 'skipped' | 'waiting'
  /** The reason code of a skipped or waiting step (text in the vocabulary's `MOTIVOS`). */
  reason?: string | null
  /** The error of a step that failed. */
  error?: { code: string; message: string } | null
}

export interface LocalDetail {
  gravacao: LocalRecording
  caminho: string | null
  marcadores: Marker[]
  etapas: Step[] | null
  /** Why the transcription waits in the queue (`Job.queue`); the sentence comes from `fraseDaEspera`. */
  espera?: FilaDaEspera | null
  /** The recording's page on eclume web, once uploaded. */
  endereco_na_web: string | null
}

export interface AgendaType {
  id: string
  nome: string
}

export type Quality = 'padrao' | 'alta'

export interface Preferences {
  sync_auto: boolean
  qualidade: Quality
  excluir_sincronizadas: boolean
}

export interface AppSettings {
  servidor: string | null
  preferencias: Preferences
  reter_dias: number
  uso_bytes: number
  versao: string
}

/** A server found through mDNS (the TXT `url`, `ca`, `v`, `name`). */
export interface Found {
  nome: string
  url: string
  ca_sha256: string | null
}

/** A new version in the server's `movel.json`. */
export interface Update {
  versao: string
  notas: string | null
}

/** An option of the saved-recording sheet's language picker; an empty `valor` is the account default. */
export interface LanguageOption {
  valor: string
  rotulo: string
}
