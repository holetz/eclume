// Filtros da busca: o que fica na URL (em pt-BR) e o que vai para `GET /api/v1/search`.
import type { operations } from '../../api/schema.gen'

export type SearchQuery = NonNullable<operations['search']['parameters']['query']>

/** Período rápido: últimos 7 ou 30 dias, este ano; vazio usa o intervalo livre (`de`/`ate`). */
export type Period = '' | '7d' | '30d' | 'ano'

export interface SearchFilters {
  q: string
  person: string
  period: Period
  from: string // AAAA-MM-DD, dia local inclusivo
  to: string // AAAA-MM-DD, dia local inclusivo
  tag: string
  collection: string
  /** `<field_id>:<valor>`, repetível. */
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

/** Há o que buscar: termos ou uma pessoa (o contrato exige um dos dois). */
export function isSearchable(filters: SearchFilters): boolean {
  return filters.q.trim() !== '' || filters.person !== ''
}

function localMidnight(day: string, plusDays = 0): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date + plusDays).toISOString()
}

/** O início do período rápido, na meia-noite local: hoje e os 6 ou 29 dias antes, ou 1º de janeiro. */
export function periodStart(period: Exclude<Period, ''>, now: Date = new Date()): string {
  if (period === 'ano') return new Date(now.getFullYear(), 0, 1).toISOString()
  const days = period === '7d' ? 6 : 29
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).toISOString()
}

/**
 * A consulta da API: o período rápido vira `from` (sem `to`); sem ele, as datas locais do intervalo
 * viram `from` no início do dia e `to` no início do dia seguinte.
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
