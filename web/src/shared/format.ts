// Rótulos e formatos em pt-BR sem dono de domínio, usados por mais de uma feature: estado e etapa da
// gravação, datas, horas, durações, tamanhos e o relógio do áudio. Valores de enum desconhecidos (o
// contrato só cresce) aparecem crus, sem quebrar a tela.
import type { Schemas } from '../api/client'
import { ESTADOS_APARELHO, ESTADOS_SERVIDOR, ETAPAS, type Tom } from '../lib/vocabulario.js'

type Recording = Schemas['Recording']
type Job = Schemas['Job']

type Tone = Tom

type Step = Schemas['PipelineStep']['step']

const STEP_BUSY: Partial<Record<string, string>> = Object.fromEntries(
  ETAPAS.map((item) => [item.etapa, item.andamento]),
)

const AFTER_TRANSCRIPTION: readonly Step[] = ['fields', 'agenda_type', 'summary']

interface RecordingState {
  state: 'failed' | 'busy' | 'waiting' | 'ready'
  label: string
  tone: Tone
  /** Pronta, mas a etapa do resumo falhou. */
  noSummary: boolean
}

/**
 * A etapa corrente em palavra, ou `null` quando nada anda: a etapa ativa, o envio ou o job, ou a
 * próxima etapa pendente depois da transcrição. "Na fila" é só a espera pela transcrição.
 */
function busyLabel(status: Recording['status'], steps: Schemas['PipelineStep'][]): string | null {
  const active = steps.find((item) => item.state === 'active')
  if (active) return STEP_BUSY[active.step] ?? active.step
  if (status === 'uploading') return ESTADOS_APARELHO.uploading.rotulo
  if (status === 'queued') return ESTADOS_SERVIDOR.na_fila.rotulo
  if (status === 'processing') return STEP_BUSY.transcription ?? 'transcription'
  const pending = steps.find((item) => item.state === 'pending' && AFTER_TRANSCRIPTION.includes(item.step))
  return pending ? (STEP_BUSY[pending.step] ?? pending.step) : null
}

/**
 * O estado da gravação como a biblioteca o mostra, lido de `status` e do `pipeline`: cancelada (a
 * gravação `failed` com uma etapa pulada por `cancelled`), falhou (a gravação ou a etapa que a torna
 * legível), aguardando locutores (a etapa `speakers` em `waiting`, à espera do dono), em andamento
 * (com a etapa corrente em palavra) ou pronta.
 */
export function recordingState(recording: Pick<Recording, 'status' | 'pipeline'>): RecordingState {
  const steps = recording.pipeline ?? []
  const failed = (step: Step) => steps.some((item) => item.step === step && item.state === 'failed')
  if (recording.status === 'failed' && steps.some((item) => item.reason === 'cancelled')) {
    const { rotulo, tom } = ESTADOS_SERVIDOR.cancelada
    return { state: 'failed', label: rotulo, tone: tom, noSummary: false }
  }
  if (recording.status === 'failed' || failed('transcription') || failed('preprocessing')) {
    const { rotulo, tom } = ESTADOS_SERVIDOR.falhou
    return { state: 'failed', label: rotulo, tone: tom, noSummary: false }
  }
  if (steps.some((item) => item.step === 'speakers' && item.state === 'waiting')) {
    const { rotulo, tom } = ESTADOS_SERVIDOR.aguardando_locutores
    return { state: 'waiting', label: rotulo, tone: tom, noSummary: false }
  }
  const label = busyLabel(recording.status, steps)
  if (label) return { state: 'busy', label, tone: ESTADOS_SERVIDOR.em_andamento.tom, noSummary: false }
  const { rotulo, tom } = ESTADOS_SERVIDOR.pronta
  return { state: 'ready', label: rotulo, tone: tom, noSummary: failed('summary') }
}

const STAGES: Record<string, string> = {
  asr: 'Reconhecendo a fala',
  alignment: 'Alinhando palavras',
  diarization: 'Separando locutores',
  embeddings: 'Calculando impressões de voz',
  finalizing: 'Finalizando',
}

export function stageLabel(stage: Job['stage'] | string): string | null {
  if (!stage) return null
  return STAGES[stage] ?? stage
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

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' })
const dateOnly = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' })

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso))
}

export function formatDate(iso: string): string {
  return dateOnly.format(new Date(iso))
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
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${units[unit]}`
}

/**
 * A referência curta de uma gravação: os 8 primeiros caracteres do id. É o sufixo do nome dos
 * arquivos da pasta sincronizada do desktop, para ligar um arquivo à gravação.
 */
export function shortRef(id: string): string {
  return id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)
}

const WEEKDAYS_SHORT = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']
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

/** Índice do dia da semana com a segunda em 0. */
export function weekdayIndex(day: Date): number {
  return (day.getDay() + 6) % 7
}

export function weekdayShort(day: Date): string {
  return WEEKDAYS_SHORT[weekdayIndex(day)]
}

/** "sáb 26 set". */
export function shortDayLabel(day: Date): string {
  return `${weekdayShort(day)} ${day.getDate()} ${MONTHS[day.getMonth()].slice(0, 3)}`
}

/** "09:05". */
export function timeLabel(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function markersLabel(count: number): string {
  return count === 1 ? '1 marcador' : `${count} marcadores`
}

/** "02:46" ou, com `withHours`, "0:02:46". */
export function formatClock(ms: number, withHours = false): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mmss = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return withHours || hours > 0 ? `${hours}:${mmss}` : mmss
}
