// Environment preferences (Environment screen): they apply only in this browser, in localStorage, with
// neither account nor server. The theme has its own module (theme.ts); density and motion become
// attributes on <html>, which app.css reads, and work hours and library opening are read by the screens that use them.
import { readStored, STORAGE_KEYS, writeStored } from './storage'

export type DensityPreference = 'comfortable' | 'compact'
export type MotionPreference = 'system' | 'reduce'
export type LibraryOpening = 'ultima' | 'semana' | 'mes' | 'lista'

export interface WorkHours {
  start: number
  end: number
}

/** The default work hours: the band highlighted in the week view and the one it frames on opening. */
export const DEFAULT_WORK_HOURS: WorkHours = { start: 8, end: 18 }

const OPENINGS: readonly LibraryOpening[] = ['ultima', 'semana', 'mes', 'lista']

export function readDensity(): DensityPreference {
  return readStored(STORAGE_KEYS.density) === 'compact' ? 'compact' : 'comfortable'
}

export function readMotion(): MotionPreference {
  return readStored(STORAGE_KEYS.motion) === 'reduce' ? 'reduce' : 'system'
}

/** The browser notification at the end of processing: enabled only by a gesture, and only with permission granted. */
export function readNotifyOutcomes(): boolean {
  return readStored(STORAGE_KEYS.notifyOutcomes) === 'on'
}

export function saveNotifyOutcomes(on: boolean): void {
  writeStored(STORAGE_KEYS.notifyOutcomes, on ? 'on' : null)
}

export type NotifyPermission = NotificationPermission | 'unsupported'

/** This site's notification permission; `unsupported` without the API (old browser, http). */
export function notifyPermission(): NotifyPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

/** The notification is in effect: enabled here and with permission granted. */
export function notifyOutcomesOn(): boolean {
  return readNotifyOutcomes() && notifyPermission() === 'granted'
}

/**
 * Enables the browser notification: asks for permission (call only on a user gesture, never on load) and
 * saves the choice if it is granted. Returns the resulting permission.
 */
export async function enableNotifyOutcomes(): Promise<NotifyPermission> {
  if (notifyPermission() === 'unsupported') return 'unsupported'
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  saveNotifyOutcomes(permission === 'granted')
  return permission
}

export function readLibraryOpening(): LibraryOpening {
  const value = readStored(STORAGE_KEYS.libraryOpening)
  return OPENINGS.find((opening) => opening === value) ?? 'ultima'
}

/** The saved work hours, or the default when missing or nonsensical (end before start). */
export function readWorkHours(): WorkHours {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(readStored(STORAGE_KEYS.workHours) ?? '')
  if (!match) return DEFAULT_WORK_HOURS
  const start = Number(match[1])
  const end = Number(match[2])
  return start >= 0 && end <= 24 && start < end ? { start, end } : DEFAULT_WORK_HOURS
}

/** Saves the density and applies it; the default removes the key. */
export function saveDensity(value: DensityPreference): void {
  writeStored(STORAGE_KEYS.density, value === 'comfortable' ? null : value)
  applyEnvironment()
}

export function saveMotion(value: MotionPreference): void {
  writeStored(STORAGE_KEYS.motion, value === 'system' ? null : value)
  applyEnvironment()
}

export function saveLibraryOpening(value: LibraryOpening): void {
  writeStored(STORAGE_KEYS.libraryOpening, value === 'ultima' ? null : value)
}

export function saveWorkHours({ start, end }: WorkHours): void {
  const isDefault = start === DEFAULT_WORK_HOURS.start && end === DEFAULT_WORK_HOURS.end
  writeStored(STORAGE_KEYS.workHours, isDefault ? null : `${start}-${end}`)
}

/** The "Primeiros passos" card was dismissed in this browser. */
export function readFirstStepsDismissed(): boolean {
  return readStored(STORAGE_KEYS.firstStepsDismissed) === '1'
}

export function dismissFirstSteps(): void {
  writeStored(STORAGE_KEYS.firstStepsDismissed, '1')
}

/** The "confira os tipos de agenda" step: the user opened "Tipos de agenda" in this browser. */
export function readAgendaTypesSeen(): boolean {
  return readStored(STORAGE_KEYS.agendaTypesSeen) === '1'
}

export function markAgendaTypesSeen(): void {
  writeStored(STORAGE_KEYS.agendaTypesSeen, '1')
}

/**
 * Resets density, motion, work hours, library opening, the browser notification and the
 * "Primeiros passos" card to the default (the theme belongs to theme.ts).
 */
export function resetEnvironment(): void {
  for (const key of [
    STORAGE_KEYS.density,
    STORAGE_KEYS.motion,
    STORAGE_KEYS.workHours,
    STORAGE_KEYS.libraryOpening,
    STORAGE_KEYS.notifyOutcomes,
    STORAGE_KEYS.firstStepsDismissed,
    STORAGE_KEYS.agendaTypesSeen,
  ]) {
    writeStored(key, null)
  }
  applyEnvironment()
}

/** Carries density and motion to <html>: `data-density="compact"` and `data-motion="reduce"`. */
export function applyEnvironment(): void {
  const root = document.documentElement
  if (readDensity() === 'compact') root.setAttribute('data-density', 'compact')
  else root.removeAttribute('data-density')
  if (readMotion() === 'reduce') root.setAttribute('data-motion', 'reduce')
  else root.removeAttribute('data-motion')
}
