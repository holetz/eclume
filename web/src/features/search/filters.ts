// Filtros da busca: o que fica na URL (em pt-BR) e o que vai para `GET /api/v1/search`.
import type { operations } from '../../api/schema.gen'

export type SearchQuery = NonNullable<operations['search']['parameters']['query']>

export interface SearchFilters {
  q: string
  person: string
  from: string // AAAA-MM-DD, dia local inclusivo
  to: string // AAAA-MM-DD, dia local inclusivo
  tag: string
  collection: string
}

const URL_KEYS: Record<keyof SearchFilters, string> = {
  q: 'q',
  person: 'pessoa',
  from: 'de',
  to: 'ate',
  tag: 'tag',
  collection: 'colecao',
}

export function filtersFromParams(params: URLSearchParams): SearchFilters {
  const entries = Object.entries(URL_KEYS).map(([key, name]) => [key, params.get(name) ?? ''])
  return Object.fromEntries(entries) as SearchFilters
}

export function paramsFromFilters(filters: SearchFilters): Record<string, string> {
  const params: Record<string, string> = {}
  for (const [key, name] of Object.entries(URL_KEYS)) {
    const value = filters[key as keyof SearchFilters].trim()
    if (value) params[name] = value
  }
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

/** Datas locais viram instantes: `from` no início do dia e `to` no início do dia seguinte. */
export function apiQuery(filters: SearchFilters): SearchQuery {
  const query: SearchQuery = {}
  if (filters.q.trim()) query.q = filters.q.trim()
  if (filters.person) query.person = filters.person
  if (filters.from) query.from = localMidnight(filters.from)
  if (filters.to) query.to = localMidnight(filters.to, 1)
  if (filters.tag) query.tag = filters.tag
  if (filters.collection) query.collection = filters.collection
  return query
}
