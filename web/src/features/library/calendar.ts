// The library in time: weeks from Monday to Sunday and the month grid, in the browser's local dates,
// and the position of each recording on the agenda (start hour and duration, in hours).
import type { Schemas } from '../../api/client'
import { i18n } from '../../i18n'
import { dayMonth, markersLabel, monthName, recordingState, timeLabel, weekdayIndex } from '../../shared/format'

type Recording = Schemas['Recording']

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

function startOfDay(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate())
}

/** Adds days on the local calendar (crosses daylight saving time without adding hours). */
export function addDays(day: Date, days: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days)
}

export function addMonths(day: Date, months: number): Date {
  return new Date(day.getFullYear(), day.getMonth() + months, 1)
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** `YYYY-MM-DD` of the local day, the format of the `data` parameter. */
export function dayKey(day: Date): string {
  const month = String(day.getMonth() + 1).padStart(2, '0')
  return `${day.getFullYear()}-${month}-${String(day.getDate()).padStart(2, '0')}`
}

/** Reads `YYYY-MM-DD` as a local day; an invalid value becomes `null`. */
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

/** The week of the day: from Monday 00:00 to the following Monday 00:00, with the seven days. */
export function weekRange(day: Date): Range & { days: Date[] } {
  const from = addDays(startOfDay(day), -weekdayIndex(day))
  const days = Array.from({ length: 7 }, (_, index) => addDays(from, index))
  return { from, to: addDays(from, 7), days }
}

export interface MonthCell {
  date: Date
  outside: boolean
}

/** The month grid in weeks from Monday to Sunday (5 or 6), with `outside` on the days outside the month. */
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

/** "segunda, 21 de setembro", "Monday, September 21". */
export function dayLabel(day: Date): string {
  const weekday = i18n.t(`library:calendar.weekday.${WEEKDAYS[weekdayIndex(day)]}`)
  return i18n.t('library:calendar.day', { weekday, date: dayMonth(day) })
}

/** "21–27 de setembro de 2026", "28 de setembro – 4 de outubro de 2026"; "September 21–27, 2026" in en. */
export function weekTitle(from: Date): string {
  const last = addDays(from, 6)
  if (from.getMonth() === last.getMonth()) {
    return i18n.t('library:calendar.weekSameMonth', {
      from: from.getDate(),
      to: last.getDate(),
      month: monthName(last),
      year: last.getFullYear(),
    })
  }
  const start = dayMonth(from, from.getFullYear() !== last.getFullYear())
  return i18n.t('library:calendar.range', { from: start, to: dayMonth(last, true) })
}

/** "Setembro de 2026", "September 2026". */
export function monthTitle(day: Date): string {
  const month = monthName(day)
  return i18n.t('library:calendar.month', { month: `${month[0].toUpperCase()}${month.slice(1)}`, year: day.getFullYear() })
}

/** "58 min", "1 h 40", "2 h"; without a duration, "—". */
export function shortDuration(ms: number | null): string {
  if (!ms) return '—'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)} min`
  const rest = minutes % 60
  return rest ? `${Math.floor(minutes / 60)} h ${String(rest).padStart(2, '0')}` : `${minutes / 60} h`
}

/** "Nota · Rascunho da pauta" for notes; the title as it is for meetings. */
export function recordingTitle(recording: Pick<Recording, 'title' | 'kind'>): string {
  return recording.kind === 'note' ? i18n.t('library:calendar.note', { title: recording.title }) : recording.title
}

/** The full label of a recording on the agenda: title, time, duration, status and markers. */
export function eventLabel(recording: Recording): string {
  const state = recordingState(recording)
  const parts = [recordingTitle(recording), timeLabel(new Date(recording.recorded_at))]
  if (recording.kind !== 'note' && recording.duration_ms) parts.push(shortDuration(recording.duration_ms))
  if (state.state !== 'ready') parts.push(state.label)
  if (recording.marker_count > 0) parts.push(markersLabel(recording.marker_count))
  return parts.join(', ')
}

interface EventBox {
  /** Start hour (9.5 = 09:30). */
  s: number
  /** Duration in hours. */
  d: number
}

const MIN_HOURS = 0.1

/** Position on the agenda: start by local time and height by duration; a note and a null duration stay minimal. */
export function eventBox(recording: Pick<Recording, 'recorded_at' | 'duration_ms' | 'kind'>): EventBox {
  const start = new Date(recording.recorded_at)
  const s = start.getHours() + start.getMinutes() / 60
  const hours = recording.kind === 'note' || !recording.duration_ms ? MIN_HOURS : recording.duration_ms / 3_600_000
  // An event that runs past midnight is cut at the end of the day.
  return { s, d: Math.max(MIN_HOURS, Math.min(hours, 24 - s)) }
}

type Laned<T> = T & { lane: number; lanes: number }

/**
 * Overlap lanes of a day: greedy by start; each group of events that touch splits the
 * width by the number of lanes it used.
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
