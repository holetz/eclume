// The UI's bridge to the core: typed `invoke`/`listen` over the Tauri commands of the app and of the
// `gravador` plugin. In the tests, the fake bridge (fake.ts) scripts the same contract.

import { createContext, useContext } from 'react'
import type {
  AgendaType,
  AppSettings,
  AppState,
  DeviceStatus,
  Found,
  LanguageOption,
  LocalDetail,
  LocalRecording,
  Marker,
  Permissions,
  Preferences,
  Update,
} from './types'

export interface Bridge {
  reportDeviceLocale(tag: string | null): Promise<void>
  state(): Promise<AppState>
  /** Subscribes to the `estado` event; returns the function that cancels. */
  onState(onChange: (state: AppState) => void): Promise<() => void>
  /** Looks for the server on the network through mDNS (the plugin) for `seconds`. */
  discover(seconds: number): Promise<Found[]>
  connectDiscovered(url: string, ca: string | null): Promise<void>
  connectAddress(address: string): Promise<void>
  trustCa(): Promise<void>
  cancelCa(): Promise<void>
  signIn(email: string, password: string): Promise<void>
  /** Opens the camera and returns the QR text, or `null` if the person cancelled. */
  scanCode(): Promise<string | null>
  cancelScan(): Promise<void>
  pair(text: string): Promise<void>
  /** Asks for the microphone and the notifications; returns what was granted. */
  permissions(): Promise<Permissions>
  /** The notifications and the battery-optimization exemption, as the system has them now. */
  device(): Promise<DeviceStatus>
  /** Opens the system screen with the app's permissions. */
  openAppSettings(): Promise<void>
  /** Asks for the battery-optimization exemption (the system dialog). */
  requestBatteryExemption(): Promise<void>
  /** `true` once per tap on the launcher icon's record-now shortcut. */
  consumeShortcut(): Promise<boolean>
  record(): Promise<string>
  pause(): Promise<void>
  resume(): Promise<void>
  mark(note?: string | null): Promise<Marker>
  annotateMarker(clientId: string, note: string | null): Promise<Marker>
  stop(): Promise<string>
  save(id: string, title: string | null, agendaTypeId: string | null, language: string | null): Promise<void>
  syncNow(): Promise<void>
  recordings(): Promise<LocalRecording[]>
  recording(id: string): Promise<LocalDetail>
  /** The local file's URL for the `<audio>` (Tauri's asset protocol). */
  fileUrl(path: string): string
  /** Opens the uploaded recording on eclume web, in the system browser. */
  openOnWeb(id: string): Promise<void>
  deleteLocal(id: string): Promise<void>
  deleteSynced(): Promise<number>
  agendaTypes(): Promise<AgendaType[]>
  /** The named account default, automatic detection and the short list of languages. */
  languages(): Promise<LanguageOption[]>
  settings(): Promise<AppSettings>
  saveSettings(preferences: Preferences): Promise<void>
  signOut(): Promise<void>
  visibility(visible: boolean): Promise<void>
  /** The device's edge-to-edge insets, in CSS px. */
  insets(): Promise<{ top: number; bottom: number }>
  checkUpdate(): Promise<Update | null>
  update(): Promise<void>
}

export const BridgeContext = createContext<Bridge | null>(null)

export function useBridge(): Bridge {
  const bridge = useContext(BridgeContext)
  if (!bridge) throw new Error('useBridge outside BridgeContext')
  return bridge
}

/** The text of a command error (the core returns text). */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return 'Algo deu errado. Tente de novo.'
}
