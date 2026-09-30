// A biblioteca no tempo: semanas de segunda a domingo e grade do mês, em datas locais do navegador,
// e a posição de cada gravação na agenda (hora de início e duração, em horas).
import type { Schemas } from '../../api/client'
import { recordingState } from './format'

type Recording = Schemas['Recording']

const WEEKDAYS_SHORT = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']
const WEEKDAYS_LONG = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo']
const MONTHS = [
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
function weekdayIndex(day: Date): number {
  return (day.getDay() + 6) % 7
}

function startOfDay(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate())
}

/** Soma dias no calendário local (atravessa o horário de verão sem somar horas). */
export function addDays(day: Date, days: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days)
}

export function addMonths(day: Date, months: number): Date {
  return new Date(day.getFullYear(), day.getMonth() + months, 1)
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** `AAAA-MM-DD` do dia local, o formato do parâmetro `data`. */
export function dayKey(day: Date): string {
  const month = String(day.getMonth() + 1).padStart(2, '0')
  return `${day.getFullYear()}-${month}-${String(day.getDate()).padStart(2, '0')}`
}

/** Lê `AAAA-MM-DD` como dia local; valor inválido vira `null`. */
export function parseDayKey(value: string | null): Date | null {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null
  if (!match) return null
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return dayKey(day) === value ? day : null
}

export interface Range {
  from: Date
  to: Date
}

/** A semana do dia: de segunda 00:00 à segunda seguinte 00:00, com os sete dias. */
export function weekRange(day: Date): Range & { days: Date[] } {
  const from = addDays(startOfDay(day), -weekdayIndex(day))
  const days = Array.from({ length: 7 }, (_, index) => addDays(from, index))
  return { from, to: addDays(from, 7), days }
}

export interface MonthCell {
  date: Date
  outside: boolean
}

/** A grade do mês em semanas de segunda a domingo (5 ou 6), com `outside` nos dias de fora do mês. */
export function monthGrid(day: Date): Range & { cells: MonthCell[] } {
  const first = new Date(day.getFullYear(), day.getMonth(), 1)
  const from = addDays(first, -weekdayIndex(first))
  const nextMonth = addMonths(first, 1)
  const cells: MonthCell[] = []
  for (let date = from; date < nextMonth || weekdayIndex(date) !== 0; date = addDays(date, 1)) {
    cells.push({ date, outside: date.getMonth() !== first.getMonth() })
  }
  return { from, to: addDays(from, cells.length), cells }
}

export function weekdayShort(day: Date): string {
  return WEEKDAYS_SHORT[weekdayIndex(day)]
}

/** "segunda, 21 de setembro". */
export function dayLabel(day: Date): string {
  return `${WEEKDAYS_LONG[weekdayIndex(day)]}, ${day.getDate()} de ${MONTHS[day.getMonth()]}`
}

/** "sáb 26 set". */
export function shortDayLabel(day: Date): string {
  return `${weekdayShort(day)} ${day.getDate()} ${MONTHS[day.getMonth()].slice(0, 3)}`
}

/** "21–27 de setembro de 2026", "28 de setembro – 4 de outubro de 2026". */
export function weekTitle(from: Date): string {
  const last = addDays(from, 6)
  const end = `${last.getDate()} de ${MONTHS[last.getMonth()]} de ${last.getFullYear()}`
  if (from.getMonth() === last.getMonth()) return `${from.getDate()}–${end}`
  const start = `${from.getDate()} de ${MONTHS[from.getMonth()]}`
  return from.getFullYear() === last.getFullYear()
    ? `${start} – ${end}`
    : `${start} de ${from.getFullYear()} – ${end}`
}

/** "Setembro de 2026". */
export function monthTitle(day: Date): string {
  const month = MONTHS[day.getMonth()]
  return `${month[0].toUpperCase()}${month.slice(1)} de ${day.getFullYear()}`
}

/** "09:00". */
export function timeLabel(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** "58 min", "1 h 40", "2 h"; sem duração, "—". */
export function shortDuration(ms: number | null): string {
  if (!ms) return '—'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)} min`
  const rest = minutes % 60
  return rest ? `${Math.floor(minutes / 60)} h ${String(rest).padStart(2, '0')}` : `${minutes / 60} h`
}

/** "Nota · Rascunho da pauta" para notas; o título como está para reuniões. */
export function recordingTitle(recording: Pick<Recording, 'title' | 'kind'>): string {
  return recording.kind === 'note' ? `Nota · ${recording.title}` : recording.title
}

export function markersLabel(count: number): string {
  return count === 1 ? '1 marcador' : `${count} marcadores`
}

/** O rótulo completo de uma gravação na agenda: título, hora, duração, estado e marcadores. */
export function eventLabel(recording: Recording): string {
  const state = recordingState(recording)
  const parts = [recordingTitle(recording), timeLabel(new Date(recording.recorded_at))]
  if (recording.kind !== 'note' && recording.duration_ms) parts.push(shortDuration(recording.duration_ms))
  if (state.state !== 'ready') parts.push(state.label)
  if (recording.marker_count > 0) parts.push(markersLabel(recording.marker_count))
  return parts.join(', ')
}

interface EventBox {
  /** Hora de início (9.5 = 09:30). */
  s: number
  /** Duração em horas. */
  d: number
}

const MIN_HOURS = 0.1

/** Posição na agenda: início pela hora local e altura pela duração; nota e duração nula ficam mínimas. */
export function eventBox(recording: Pick<Recording, 'recorded_at' | 'duration_ms' | 'kind'>): EventBox {
  const start = new Date(recording.recorded_at)
  const s = start.getHours() + start.getMinutes() / 60
  const hours = recording.kind === 'note' || !recording.duration_ms ? MIN_HOURS : recording.duration_ms / 3_600_000
  // Um evento que passa da meia-noite é cortado no fim do dia.
  return { s, d: Math.max(MIN_HOURS, Math.min(hours, 24 - s)) }
}

type Laned<T> = T & { lane: number; lanes: number }

/**
 * Faixas de sobreposição de um dia: guloso por início; cada grupo de eventos que se tocam divide a
 * largura pelo número de faixas que usou.
 */
export function lanes<T extends EventBox>(boxes: T[]): Laned<T>[] {
  const sorted = [...boxes].sort((a, b) => a.s - b.s || b.d - a.d)
  const result: Laned<T>[] = []
  let group: Laned<T>[] = []
  let laneEnds: number[] = []
  let groupEnd = -Infinity

  const closeGroup = () => {
    for (const item of group) item.lanes = laneEnds.length
    group = []
    laneEnds = []
  }

  for (const box of sorted) {
    if (box.s >= groupEnd) {
      closeGroup()
      groupEnd = -Infinity
    }
    let lane = laneEnds.findIndex((end) => end <= box.s)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(0)
    }
    laneEnds[lane] = box.s + box.d
    groupEnd = Math.max(groupEnd, box.s + box.d)
    const laned = { ...box, lane, lanes: 1 }
    group.push(laned)
    result.push(laned)
  }
  closeGroup()
  return result
}
