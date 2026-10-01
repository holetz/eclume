// Preferências do ambiente (tela Ambiente): valem só neste navegador, no localStorage, sem conta nem
// servidor. O tema tem módulo próprio (theme.ts); densidade e movimento viram atributos no <html>,
// que o app.css lê, e expediente e abertura da biblioteca são lidos pelas telas que os usam.
import { readStored, STORAGE_KEYS, writeStored } from './storage'

export type DensityPreference = 'comfortable' | 'compact'
export type MotionPreference = 'system' | 'reduce'
export type LibraryOpening = 'ultima' | 'semana' | 'mes' | 'lista'

export interface WorkHours {
  start: number
  end: number
}

/** O expediente padrão: a faixa destacada na semana e a que ela enquadra ao abrir. */
export const DEFAULT_WORK_HOURS: WorkHours = { start: 8, end: 18 }

const OPENINGS: readonly LibraryOpening[] = ['ultima', 'semana', 'mes', 'lista']

export function readDensity(): DensityPreference {
  return readStored(STORAGE_KEYS.density) === 'compact' ? 'compact' : 'comfortable'
}

export function readMotion(): MotionPreference {
  return readStored(STORAGE_KEYS.motion) === 'reduce' ? 'reduce' : 'system'
}

/** O aviso do navegador no fim do processamento: ligado só por gesto, e só com a permissão dada. */
export function readNotifyOutcomes(): boolean {
  return readStored(STORAGE_KEYS.notifyOutcomes) === 'on'
}

export function saveNotifyOutcomes(on: boolean): void {
  writeStored(STORAGE_KEYS.notifyOutcomes, on ? 'on' : null)
}

export type NotifyPermission = NotificationPermission | 'unsupported'

/** A permissão de notificação deste site; `unsupported` sem a API (navegador antigo, http). */
export function notifyPermission(): NotifyPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

/** O aviso está valendo: ligado aqui e com a permissão dada. */
export function notifyOutcomesOn(): boolean {
  return readNotifyOutcomes() && notifyPermission() === 'granted'
}

/**
 * Liga o aviso do navegador: pede a permissão (chamar só num gesto da pessoa, nunca ao carregar) e
 * grava a escolha se ela for dada. Devolve a permissão resultante.
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

/** O expediente guardado, ou o padrão quando falta ou não faz sentido (fim antes do início). */
export function readWorkHours(): WorkHours {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(readStored(STORAGE_KEYS.workHours) ?? '')
  if (!match) return DEFAULT_WORK_HOURS
  const start = Number(match[1])
  const end = Number(match[2])
  return start >= 0 && end <= 24 && start < end ? { start, end } : DEFAULT_WORK_HOURS
}

/** Grava a densidade e a aplica; o padrão apaga a chave. */
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

/** O cartão Primeiros passos foi dispensado neste navegador. */
export function readFirstStepsDismissed(): boolean {
  return readStored(STORAGE_KEYS.firstStepsDismissed) === '1'
}

export function dismissFirstSteps(): void {
  writeStored(STORAGE_KEYS.firstStepsDismissed, '1')
}

/** O passo "confira os tipos de agenda": a pessoa abriu Tipos de agenda neste navegador. */
export function readAgendaTypesSeen(): boolean {
  return readStored(STORAGE_KEYS.agendaTypesSeen) === '1'
}

export function markAgendaTypesSeen(): void {
  writeStored(STORAGE_KEYS.agendaTypesSeen, '1')
}

/**
 * Volta densidade, movimento, expediente, abertura da biblioteca, o aviso do navegador e o cartão
 * Primeiros passos ao padrão (o tema é do theme.ts).
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

/** Leva densidade e movimento para o <html>: `data-density="compact"` e `data-motion="reduce"`. */
export function applyEnvironment(): void {
  const root = document.documentElement
  if (readDensity() === 'compact') root.setAttribute('data-density', 'compact')
  else root.removeAttribute('data-density')
  if (readMotion() === 'reduce') root.setAttribute('data-motion', 'reduce')
  else root.removeAttribute('data-motion')
}
