// Labels and formats with no domain owner, used by more than one feature: recording state and step,
// dates, times, durations, sizes and the audio clock, in the active locale (the `shared` catalog and
// `Intl`). The tones still come from lib/vocabulario.js, whose pt-BR labels are the desktop's and the
// phone's. Unknown enum values (the contract only grows) show up raw, without breaking the screen.
import type { Schemas } from '../api/client'
import { activeLocale, i18n } from '../i18n'
import { ESTADOS_SERVIDOR, type Tom } from '../lib/vocabulario.js'

type Recording = Schemas['Recording']
type Job = Schemas['Job']

type Tone = Tom

type Step = Schemas['PipelineStep']['step']

const BUSY_STEPS = ['received', 'preprocessing', 'transcription', 'speakers', 'agenda_type', 'fields', 'summary'] as const

/** The step in progress as a word ("Transcribing"), or the raw step for an unknown one. */
function stepBusy(step: string): string {
  return (BUSY_STEPS as readonly string[]).includes(step)
    ? i18n.t(`shared:busy.${step as (typeof BUSY_STEPS)[number]}`)
    : step
}

const AFTER_TRANSCRIPTION: readonly Step[] = ['fields', 'agenda_type', 'summary']

interface RecordingState {
  state: 'failed' | 'busy' | 'waiting' | 'ready'
  label: string
  tone: Tone
  /** Ready, but the summary step failed. */
  noSummary: boolean
}

/**
 * The current step as a word, or `null` when nothing is moving: the active step, the upload or the
 * job, or the next pending step after transcription. "Queued" is only the wait for transcription.
 */
function busyLabel(status: Recording['status'], steps: Schemas['PipelineStep'][]): string | null {
  const active = steps.find((item) => item.state === 'active')
  if (active) return stepBusy(active.step)
  if (status === 'uploading') return i18n.t('shared:state.uploading')
  if (status === 'queued') return i18n.t('shared:state.queued')
  if (status === 'processing') return stepBusy('transcription')
  const pending = steps.find((item) => item.state === 'pending' && AFTER_TRANSCRIPTION.includes(item.step))
  return pending ? stepBusy(pending.step) : null
}

/**
 * The recording state as the library shows it, read from `status` and the `pipeline`: cancelled (the
 * `failed` recording with a step skipped by `cancelled`), failed (the recording, or the step that
 * makes it readable), awaiting speakers (the `speakers` step in `waiting`, waiting for the owner),
 * in progress (with the current step as a word) or ready.
 */
export function recordingState(recording: Pick<Recording, 'status' | 'pipeline'>): RecordingState {
  const steps = recording.pipeline ?? []
  const failed = (step: Step) => steps.some((item) => item.step === step && item.state === 'failed')
  if (recording.status === 'failed' && steps.some((item) => item.reason === 'cancelled')) {
    return { state: 'failed', label: i18n.t('shared:state.cancelled'), tone: ESTADOS_SERVIDOR.cancelada.tom, noSummary: false }
  }
  if (recording.status === 'failed' || failed('transcription') || failed('preprocessing')) {
    return { state: 'failed', label: i18n.t('shared:state.failed'), tone: ESTADOS_SERVIDOR.falhou.tom, noSummary: false }
  }
  if (steps.some((item) => item.step === 'speakers' && item.state === 'waiting')) {
    const tone = ESTADOS_SERVIDOR.aguardando_locutores.tom
    return { state: 'waiting', label: i18n.t('shared:state.awaitingSpeakers'), tone, noSummary: false }
  }
  const label = busyLabel(recording.status, steps)
  if (label) return { state: 'busy', label, tone: ESTADOS_SERVIDOR.em_andamento.tom, noSummary: false }
  return { state: 'ready', label: i18n.t('shared:state.ready'), tone: ESTADOS_SERVIDOR.pronta.tom, noSummary: failed('summary') }
}

const STAGES = ['asr', 'alignment', 'diarization', 'embeddings', 'finalizing'] as const

export function stageLabel(stage: Job['stage'] | string): string | null {
  if (!stage) return null
  return (STAGES as readonly string[]).includes(stage) ? i18n.t(`shared:stage.${stage as (typeof STAGES)[number]}`) : stage
}

/** "45 s", "2 min 46 s", "1 h 05 min". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`
  if (minutes > 0) return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`
  return `${seconds} s`
}

const formats = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>()

/** One `Intl` formatter per locale and options, so a locale switch formats with the new one. */
function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat>(kind: string, make: (locale: string) => T): T {
  const locale = activeLocale()
  const key = `${locale}|${kind}`
  let format = formats.get(key)
  if (!format) {
    format = make(locale)
    formats.set(key, format)
  }
  return format as T
}

const dateFormat = (kind: string, options: Intl.DateTimeFormatOptions) =>
  cached(kind, (locale) => new Intl.DateTimeFormat(locale, options))

export function formatDateTime(iso: string): string {
  return dateFormat('dateTime', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
}

export function formatDate(iso: string): string {
  return dateFormat('date', { dateStyle: 'medium' }).format(new Date(iso))
}

/** "11,1 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const number = cached('bytes', (locale) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }))
  return `${number.format(value)} ${units[unit]}`
}

/**
 * A recording's short reference: the first 8 characters of the id. It is the suffix of the file
 * names in the desktop synced folder, to link a file to its recording.
 */
export function shortRef(id: string): string {
  return id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)
}

/** The library's pt-BR month names, for its pt-BR period phrases (translated with the library, #250). */
export const MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
]

/** Index of the weekday, with Monday at 0. */
export function weekdayIndex(day: Date): number {
  return (day.getDay() + 6) % 7
}

/** "sáb", "Sat": the short weekday in the active locale, without the abbreviation dot. */
export function weekdayShort(day: Date): string {
  return dateFormat('weekday', { weekday: 'short' }).format(day).replace(/\.$/, '')
}

/** "sáb 26 set", "Sat 26 Sep". */
export function shortDayLabel(day: Date): string {
  const month = dateFormat('month', { month: 'short' }).format(day).replace(/\.$/, '')
  return `${weekdayShort(day)} ${day.getDate()} ${month}`
}

/** "09:05". */
export function timeLabel(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function markersLabel(count: number): string {
  return i18n.t('shared:markers', { count })
}

/** "02:46" or, with `withHours`, "0:02:46". */
export function formatClock(ms: number, withHours = false): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mmss = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return withHours || hours > 0 ? `${hours}:${mmss}` : mmss
}
