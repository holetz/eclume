// Rótulos e formatos em pt-BR das gravações. Valores de enum desconhecidos (o contrato só cresce)
// aparecem crus, sem quebrar a tela.
import type { Schemas } from '../../api/client'

type Recording = Schemas['Recording']
type Job = Schemas['Job']

export type Tone = 'neutral' | 'progress' | 'success' | 'danger' | 'warning'

const STATUS: Record<string, { label: string; tone: Tone }> = {
  uploading: { label: 'Enviando', tone: 'warning' },
  queued: { label: 'Na fila', tone: 'neutral' },
  processing: { label: 'Transcrevendo', tone: 'progress' },
  transcribed: { label: 'Transcrita', tone: 'success' },
  failed: { label: 'Falhou', tone: 'danger' },
}

export function statusInfo(status: Recording['status'] | string): { label: string; tone: Tone } {
  return STATUS[status] ?? { label: status, tone: 'neutral' }
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

const SOURCES: Record<string, string> = {
  desktop: 'App desktop',
  upload: 'Import pelo navegador',
  api: 'API',
}

export function sourceLabel(source: string): string {
  return SOURCES[source] ?? source
}

/** Gravação com job em andamento, que merece polling. */
export function isActive(recording: Pick<Recording, 'status'>): boolean {
  return recording.status === 'uploading' || recording.status === 'queued' || recording.status === 'processing'
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
