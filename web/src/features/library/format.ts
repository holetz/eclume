// Rótulos e formatos em pt-BR das gravações. Valores de enum desconhecidos (o contrato só cresce)
// aparecem crus, sem quebrar a tela.
import type { Schemas } from '../../api/client'

type Recording = Schemas['Recording']
type Job = Schemas['Job']

type Tone = 'neutral' | 'progress' | 'success' | 'danger' | 'warning'

type Step = Schemas['PipelineStep']['step']

const STEP_BUSY: Partial<Record<string, string>> = {
  received: 'Enviando',
  preprocessing: 'Pré-processando',
  transcription: 'Transcrevendo',
  fields: 'Preenchendo campos',
  agenda_type: 'Detectando o tipo',
  summary: 'Resumindo',
}

const AFTER_TRANSCRIPTION: readonly Step[] = ['fields', 'agenda_type', 'summary']

interface RecordingState {
  state: 'failed' | 'busy' | 'ready'
  label: string
  tone: Tone
  /** Pronta, mas a etapa do resumo falhou. */
  noSummary: boolean
}

/**
 * A etapa corrente em palavra, ou `null` quando nada anda: a etapa ativa, o envio ou o job, ou a
 * próxima etapa pendente depois da transcrição.
 */
function busyLabel(status: Recording['status'], steps: Schemas['PipelineStep'][]): string | null {
  const active = steps.find((item) => item.state === 'active')
  if (active) return STEP_BUSY[active.step] ?? active.step
  if (status === 'uploading') return 'Enviando'
  if (status === 'queued') return 'Na fila'
  if (status === 'processing') return 'Transcrevendo'
  const pending = steps.find((item) => item.state === 'pending' && AFTER_TRANSCRIPTION.includes(item.step))
  return pending ? (STEP_BUSY[pending.step] ?? pending.step) : null
}

/**
 * O estado da gravação como a biblioteca o mostra, lido de `status` e do `pipeline`: falhou (a
 * gravação ou a etapa que a torna legível), em andamento (com a etapa corrente em palavra) ou pronta.
 */
export function recordingState(recording: Pick<Recording, 'status' | 'pipeline'>): RecordingState {
  const steps = recording.pipeline ?? []
  const failed = (step: Step) => steps.some((item) => item.step === step && item.state === 'failed')
  if (recording.status === 'failed' || failed('transcription') || failed('preprocessing')) {
    return { state: 'failed', label: 'Falhou', tone: 'danger', noSummary: false }
  }
  const label = busyLabel(recording.status, steps)
  if (label) return { state: 'busy', label, tone: 'progress', noSummary: false }
  return { state: 'ready', label: 'Pronta', tone: 'success', noSummary: failed('summary') }
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
