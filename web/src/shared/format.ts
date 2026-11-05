// Labels and formats with no domain owner, used by more than one feature: recording state and step,
// the pipeline vocabulary (step names and states, skip reasons, device states, the queue wait), dates,
// times, durations, sizes and the audio clock, in the active locale (the `shared` catalog and `Intl`).
// The tones still come from lib/vocabulario.js, whose pt-BR labels are the desktop's and the phone's
// (vocabulary.test.ts keeps the pt-BR catalog equal to them). Unknown enum values (the contract only
// grows) show up raw, without breaking the screen.
import type { Schemas } from '../api/client'
import { activeLocale, i18n } from '../i18n'
import { ESTADOS_SERVIDOR, type Tom } from '../lib/vocabulario.js'

type Recording = Schemas['Recording']
type Job = Schemas['Job']

type Tone = Tom

type Step = Schemas['PipelineStep']['step']

const BUSY_STEPS = ['received', 'preprocessing', 'transcription', 'speakers', 'agenda_type', 'fields', 'summary'] as const

/** The step's name ("Transcription"), or the raw step for an unknown one. */
export function stepName(step: string): string {
  return (BUSY_STEPS as readonly string[]).includes(step)
    ? i18n.t(`shared:step.${step as (typeof BUSY_STEPS)[number]}`)
    : step
}

export type StepState = 'pending' | 'active' | 'done' | 'skipped' | 'failed' | 'waiting'

/** The step's state as a word ("skipped"), to be read without the bar's color. */
export function stepStateLabel(state: StepState): string {
  return i18n.t(`shared:stepState.${state}`)
}

const REASONS = [
  'no_provider',
  'no_auto_fields',
  'no_types',
  'set_by_user',
  'no_agenda_type',
  'before_pipeline',
  'worker_without_preprocess',
  'summary_deleted',
  'cancelled',
  'unnamed_speakers',
  'continued_by_user',
  'naming_not_required',
] as const

/** The text of a skipped or waiting step's `reason`, or the code itself when it has no text yet. */
export function reasonText(code: string): string {
  return (REASONS as readonly string[]).includes(code) ? i18n.t(`shared:reason.${code as (typeof REASONS)[number]}`) : code
}

export type DeviceState = 'recording' | 'pending' | 'uploading' | 'uploaded' | 'interrupted' | 'failed'

/** The recording on the device, before and during upload ("Uploading"). */
export function deviceStateLabel(state: DeviceState): string {
  return i18n.t(`shared:device.${state}`)
}

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

/** "novembro", "November": the month's long name in the active locale. */
export function monthName(day: Date): string {
  return dateFormat('monthLong', { month: 'long' }).format(day)
}

/** "3 de novembro", "November 3"; with `withYear`, "3 de novembro de 2026", "November 3, 2026". */
export function dayMonth(day: Date, withYear = false): string {
  return withYear
    ? dateFormat('dayMonthYear', { day: 'numeric', month: 'long', year: 'numeric' }).format(day)
    : dateFormat('dayMonth', { day: 'numeric', month: 'long' }).format(day)
}

/** The library's pt-BR month names, until its period phrases move to `monthName` and `dayMonth` (task 2.1). */
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

interface QueueWait {
  reason: string
  ahead?: number | null
  account_ahead?: number | null
  estimated_start_at?: string | null
  resumes_at?: string | null
  processor?: { online: boolean; offline_since?: string | null }
}

/** An instant's time: "14:02" on the same day, "02/10 às 14:02" on another. */
function instantLabel(iso: string, now: Date): string {
  const date = new Date(iso)
  const time = timeLabel(date)
  if (date.toDateString() === now.toDateString()) return time
  const day = dateFormat('dayMonthNumeric', { day: '2-digit', month: '2-digit' }).format(date)
  return i18n.t('shared:queue.dayTime', { date: day, time })
}

/** How long until an instant, in words: "menos de 1 min", "cerca de 12 min", "cerca de 1 h 20 min". */
function etaLabel(iso: string, now: Date): string {
  const minutes = Math.round((new Date(iso).getTime() - now.getTime()) / 60000)
  if (minutes < 1) return i18n.t('shared:queue.lessThanMinute')
  if (minutes < 60) return i18n.t('shared:queue.minutes', { minutes })
  const rest = minutes % 60
  const hours = Math.floor(minutes / 60)
  return rest ? i18n.t('shared:queue.hoursMinutes', { hours, minutes: rest }) : i18n.t('shared:queue.hours', { hours })
}

/**
 * The wait of a recording in the transcription queue (`Job.queue`), the same rule as the desktop's
 * and the phone's (`fraseDaEspera` in lib/vocabulario.js); `null` with no wait. The start forecast is
 * always labeled as an estimate.
 */
export function waitingPhrase(queue: QueueWait | null | undefined, now = new Date()): string | null {
  if (!queue) return null
  const processor = queue.processor
  if (processor && !processor.online) {
    return processor.offline_since
      ? i18n.t('shared:queue.offlineSince', { time: instantLabel(processor.offline_since, now) })
      : i18n.t('shared:queue.offline')
  }
  if (queue.reason === 'account_turn') {
    const ahead = queue.account_ahead ?? 0
    return ahead === 0 ? i18n.t('shared:queue.accountNext') : i18n.t('shared:queue.accountAhead', { count: ahead })
  }
  if (queue.reason === 'quota_window') {
    return queue.resumes_at
      ? i18n.t('shared:queue.quotaAt', { time: instantLabel(queue.resumes_at, now) })
      : i18n.t('shared:queue.quotaLater')
  }
  const parts: string[] = []
  if (queue.ahead != null) parts.push(i18n.t('shared:queue.position', { position: queue.ahead + 1 }))
  if (queue.estimated_start_at) parts.push(i18n.t('shared:queue.starts', { eta: etaLabel(queue.estimated_start_at, now) }))
  return parts.length > 0 ? parts.join(' · ') : i18n.t('shared:queue.waiting')
}
