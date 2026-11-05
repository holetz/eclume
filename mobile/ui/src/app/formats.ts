import { activeLocale, formatLocale, t } from '../i18n'

const TWO = (n: number) => String(n).padStart(2, '0')

/** The recording clock: `00:42:10`. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${TWO(Math.floor(s / 3600))}:${TWO(Math.floor((s % 3600) / 60))}:${TWO(s % 60)}`
}

/** The duration: `54 min`, `1 h 12 min`, or the under-a-minute text. */
export function duration(ms: number | null): string {
  if (ms === null) return '—'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return t('formats.lessThanMinute')
  if (minutes < 60) return `${minutes} min`
  const rest = minutes % 60
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`
}

/** pt-BR's short month and weekday names, without Intl's trailing dot (`set`, not `set.`). */
const MONTHS = () => t('formats.months').split(' ')
const DAYS = () => t('formats.days').split(' ')

function month(date: Date): string {
  return new Intl.DateTimeFormat(formatLocale(), { month: 'short' }).format(date)
}

function weekday(date: Date): string {
  return new Intl.DateTimeFormat(formatLocale(), { weekday: 'short' }).format(date)
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** When: today, yesterday or the date, with the time (`26 set 09:00`). */
export function when(ts: number, now: Date = new Date()): string {
  const date = new Date(ts)
  const time = `${TWO(date.getHours())}:${TWO(date.getMinutes())}`
  if (sameDay(date, now)) return t('formats.today', { time })
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(date, yesterday)) return t('formats.yesterday', { time })
  return activeLocale() === 'pt-BR'
    ? `${date.getDate()} ${MONTHS()[date.getMonth()]} ${time}`
    : `${month(date)} ${date.getDate()} ${time}`
}

/** The detail's long date: weekday, day, month, year and time. */
export function longDate(ts: number): string {
  const date = new Date(ts)
  if (activeLocale() === 'en') return `${weekday(date)} ${month(date)} ${date.getDate()} ${date.getFullYear()} · ${TWO(date.getHours())}:${TWO(date.getMinutes())}`
  return `${DAYS()[date.getDay()]} ${date.getDate()} ${MONTHS()[date.getMonth()]} ${date.getFullYear()} · ${TWO(date.getHours())}:${TWO(date.getMinutes())}`
}

/** The title suggested on the saved-recording sheet: weekday, day, month and time. */
export function suggestedTitle(ts: number): string {
  const date = new Date(ts)
  if (activeLocale() === 'en') return `${weekday(date)} ${month(date)} ${date.getDate()}, ${TWO(date.getHours())}:${TWO(date.getMinutes())}`
  return `${DAYS()[date.getDay()]} ${date.getDate()} ${MONTHS()[date.getMonth()]}, ${TWO(date.getHours())}:${TWO(date.getMinutes())}`
}

/** Bytes: `10 MB`, `1,1 GB`. */
export function size(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes >= 1e9) return `${(bytes / 1e9).toLocaleString(formatLocale(), { maximumFractionDigits: 1 })} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6).toLocaleString(formatLocale())} MB`
  return `${Math.max(1, Math.round(bytes / 1e3)).toLocaleString(formatLocale())} kB`
}

/** Rate: `18 MB/s`, `640 kB/s`. */
export function rate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1e6) return `${Math.round(bytesPerSecond / 1e6).toLocaleString(formatLocale())} MB/s`
  return `${Math.round(bytesPerSecond / 1e3).toLocaleString(formatLocale())} kB/s`
}

/** The marker count, singular or plural. */
export function markers(n: number): string {
  return t('formats.markers', { count: n })
}
