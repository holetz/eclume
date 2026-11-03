// The library filters and view live in the URL, in pt-BR, and become the query of `GET /recordings`.
import type { Schemas } from '../../api/client'

type Kind = Schemas['RecordingKind']
type Status = Schemas['RecordingStatus']

export type LibraryView = 'semana' | 'mes' | 'lista'
export type KindParam = 'reuniao' | 'nota'
export type StatusParam = 'pronta' | 'processando' | 'falhou'
/** What the recording awaits from you to move on (`Recording.awaiting`), in the URL in pt-BR. */
export type NeedsParam = 'locutores'

export const KINDS: Record<KindParam, Kind> = { reuniao: 'meeting', nota: 'note' }

/** "Precisam de você" → the contract's `awaiting`. */
export const NEEDS: Record<NeedsParam, 'speakers'> = { locutores: 'speakers' }

/**
 * Screen status → contract states. "Processando" joins upload, queue and transcription; a
 * transcribed recording with the summary still in progress counts as ready in the server filter.
 */
export const STATUS_GROUPS: Record<StatusParam, Status[]> = {
  pronta: ['transcribed'],
  processando: ['uploading', 'queued', 'processing'],
  falhou: ['failed'],
}

export interface LibraryFilters {
  kind: KindParam[]
  status: StatusParam[]
  tag: string[]
  person: string[]
  collection: string[]
  /** `<field_id>:<value>`. */
  field: string[]
  /** Attributes of one same participant (a person linked to a speaker). */
  personCompany: string[]
  personDepartment: string[]
  personTag: string[]
  /** Need you: the recording stopped waiting for the speakers' names. */
  needs: NeedsParam[]
}

const FILTER_PARAMS: Record<keyof LibraryFilters, string> = {
  kind: 'tipo',
  status: 'situacao',
  tag: 'tag',
  person: 'pessoa',
  collection: 'colecao',
  field: 'campo',
  personCompany: 'empresa',
  personDepartment: 'area',
  personTag: 'tag-pessoa',
  needs: 'precisa',
}

const VIEWS: readonly LibraryView[] = ['semana', 'mes', 'lista']

function only<T extends string>(values: string[], allowed: readonly T[]): T[] {
  return [...new Set(values.filter((value): value is T => (allowed as readonly string[]).includes(value)))]
}

export function readFilters(params: URLSearchParams): LibraryFilters {
  const all = (key: keyof LibraryFilters) => [...new Set(params.getAll(FILTER_PARAMS[key]).filter(Boolean))]
  return {
    kind: only(params.getAll('tipo'), Object.keys(KINDS) as KindParam[]),
    status: only(params.getAll('situacao'), Object.keys(STATUS_GROUPS) as StatusParam[]),
    tag: all('tag'),
    person: all('person'),
    collection: all('collection'),
    field: all('field').filter((value) => /^[^:]+:.+$/.test(value)),
    personCompany: all('personCompany'),
    personDepartment: all('personDepartment'),
    personTag: all('personTag'),
    needs: only(params.getAll('precisa'), Object.keys(NEEDS) as NeedsParam[]),
  }
}

export function readView(params: URLSearchParams): LibraryView | null {
  const view = params.get('visao')
  return VIEWS.includes(view as LibraryView) ? (view as LibraryView) : null
}

/** Replaces the filters in the URL, keeping view, date and the rest. */
export function writeFilters(params: URLSearchParams, filters: LibraryFilters): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const [key, param] of Object.entries(FILTER_PARAMS) as [keyof LibraryFilters, string][]) {
    next.delete(param)
    for (const value of filters[key]) next.append(param, value)
  }
  return next
}

export const NO_FILTERS: LibraryFilters = {
  kind: [],
  status: [],
  tag: [],
  person: [],
  collection: [],
  field: [],
  personCompany: [],
  personDepartment: [],
  personTag: [],
  needs: [],
}

/** How many filters are on (one per chosen value). */
export function activeFilterCount(filters: LibraryFilters): number {
  return Object.values(filters).reduce((total, values) => total + values.length, 0)
}

type RecordingsQuery = NonNullable<import('../../api/schema.gen').operations['listRecordings']['parameters']['query']>

/** The filter part of the `GET /recordings` query. A group with everything checked does not send the parameter. */
export function filtersToQuery(filters: LibraryFilters): RecordingsQuery {
  const query: RecordingsQuery = {}
  const kinds = filters.kind.map((kind) => KINDS[kind])
  if (kinds.length > 0 && kinds.length < Object.keys(KINDS).length) query.kind = kinds
  if (filters.status.length > 0 && filters.status.length < Object.keys(STATUS_GROUPS).length) {
    query.status = filters.status.flatMap((status) => STATUS_GROUPS[status])
  }
  if (filters.tag.length) query.tag = filters.tag
  if (filters.person.length) query.person = filters.person
  if (filters.collection.length) query.collection = filters.collection
  if (filters.field.length) query.field = filters.field
  if (filters.personCompany.length) query.person_company = filters.personCompany
  if (filters.personDepartment.length) query.person_department = filters.personDepartment
  if (filters.personTag.length) query.person_tag = filters.personTag
  if (filters.needs.length) query.awaiting = filters.needs.map((need) => NEEDS[need])
  return query
}

/** The query string the library remembers (without the Import modal). */
export function rememberedSearch(params: URLSearchParams): string {
  const next = new URLSearchParams(params)
  next.delete('importar')
  return next.toString()
}
