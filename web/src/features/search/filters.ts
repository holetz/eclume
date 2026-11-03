// Search filters: what stays in the URL (in pt-BR) and what goes to `GET /api/v1/search`.
import type { operations } from '../../api/schema.gen'

type SearchQuery = NonNullable<operations['search']['parameters']['query']>

/** Quick period: last 7 or 30 days, this year; empty uses the free range (`de`/`ate`). */
export type Period = '' | '7d' | '30d' | 'ano'

export interface SearchFilters {
  q: string
  person: string
  period: Period
  from: string // YYYY-MM-DD, local day, inclusive
  to: string // YYYY-MM-DD, local day, inclusive
  tag: string
  collection: string
  /** `<field_id>:<value>`, repeatable. */
  field: string[]
}

type SingleKey = Exclude<keyof SearchFilters, 'field'>

const URL_KEYS: Record<SingleKey, string> = {
  q: 'q',
  person: 'pessoa',
  period: 'periodo',
  from: 'de',
  to: 'ate',
  tag: 'tag',
  collection: 'colecao',
}

const PERIODS: readonly Period[] = ['7d', '30d', 'ano']

export const EMPTY_FILTERS: SearchFilters = {
  q: '',
  person: '',
  period: '',
  from: '',
  to: '',
  tag: '',
  collection: '',
  field: [],
}

export function filtersFromParams(params: URLSearchParams): SearchFilters {
  const single = Object.fromEntries(
    Object.entries(URL_KEYS).map(([key, name]) => [key, params.get(name) ?? '']),
  ) as Record<SingleKey, string>
  return {
    ...single,
    period: PERIODS.includes(single.period as Period) ? (single.period as Period) : '',
    field: params.getAll('campo').filter((value) => /^[^:]+:.+$/.test(value)),
  }
}

export function paramsFromFilters(filters: SearchFilters): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, name] of Object.entries(URL_KEYS)) {
    const value = filters[key as SingleKey].trim()
    if (value) params.set(name, value)
  }
  for (const value of filters.field) params.append('campo', value)
  return params
}

/** There is something to search: terms or a person (the contract requires one of the two). */
export function isSearchable(filters: SearchFilters): boolean {
  return filters.q.trim() !== '' || filters.person !== ''
}

function localMidnight(day: string, plusDays = 0): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date + plusDays).toISOString()
}

/** The start of the quick period, at local midnight: today and the 6 or 29 days before, or January 1st. */
export function periodStart(period: Exclude<Period, ''>, now: Date = new Date()): string {
  if (period === 'ano') return new Date(now.getFullYear(), 0, 1).toISOString()
  const days = period === '7d' ? 6 : 29
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).toISOString()
}

/**
 * The API query: the quick period becomes `from` (without `to`); without it, the local dates of the range
 * become `from` at the start of the day and `to` at the start of the next day.
 */
export function apiQuery(filters: SearchFilters, now: Date = new Date()): SearchQuery {
  const query: SearchQuery = {}
  if (filters.q.trim()) query.q = filters.q.trim()
  if (filters.person) query.person = filters.person
  if (filters.period) {
    query.from = periodStart(filters.period, now)
  } else {
    if (filters.from) query.from = localMidnight(filters.from)
    if (filters.to) query.to = localMidnight(filters.to, 1)
  }
  if (filters.tag) query.tag = filters.tag
  if (filters.collection) query.collection = filters.collection
  if (filters.field.length > 0) query.field = filters.field
  return query
}
