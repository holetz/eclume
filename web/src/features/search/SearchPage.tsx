import { useInfiniteQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useSearchParams } from 'react-router'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { useCollections } from '../collections/queries'

import { useUserFields } from '../library/queries'
import { recordingAt, usePeopleOptions } from '../people/queries'
import { useTags } from '../tags/queries'
import { hms } from '../transcript/markers'
import { PersonCombobox } from '../people/PersonCombobox'
import { speakerColorIndex, speakerName } from '../transcript/segments'
import { FilterChip } from './FilterChip'
import {
  apiQuery,
  EMPTY_FILTERS,
  filtersFromParams,
  isSearchable,
  paramsFromFilters,
  type Period,
  type SearchFilters,
} from './filters'
import { groupHits, totalLabel, type HitGroup } from './group'
import { parseHighlight } from './highlight'
import styles from './SearchPage.module.css'
import { activeLocale, i18n } from '../../i18n'
import { shortDayLabel } from '../../shared/format'

const periodLabel = (period: Exclude<Period, ''>) => i18n.t(`search:period.${period}`)

/** "19/09/2026" in pt-BR, "09/19/2026" in English: the day of a `YYYY-MM-DD` without a time zone shift. */
function formatDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Intl.DateTimeFormat(activeLocale(), { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, date)),
  )
}

function periodValue(filters: SearchFilters): string {
  if (filters.period) return periodLabel(filters.period)
  if (filters.from && filters.to) return i18n.t('search:period.range', { from: formatDay(filters.from), to: formatDay(filters.to) })
  if (filters.from) return i18n.t('search:period.since', { from: formatDay(filters.from) })
  if (filters.to) return i18n.t('search:period.until', { to: formatDay(filters.to) })
  return i18n.t('search:any')
}

function PeriodEditor({
  filters,
  onApply,
}: {
  filters: SearchFilters
  onApply: (next: Partial<SearchFilters>) => void
}) {
  const { t } = useTranslation('search')
  const name = useId()
  const [choice, setChoice] = useState<Period | 'intervalo'>(
    filters.period || (filters.from || filters.to ? 'intervalo' : ''),
  )
  const [from, setFrom] = useState(filters.from)
  const [to, setTo] = useState(filters.to)
  const options: { value: Period | 'intervalo'; label: string }[] = [
    { value: '', label: t('anyDate') },
    { value: '7d', label: periodLabel('7d') },
    { value: '30d', label: periodLabel('30d') },
    { value: 'ano', label: periodLabel('ano') },
    { value: 'intervalo', label: t('interval') },
  ]
  return (
    <div className={styles.editor}>
      {options.map((option) => (
        <label key={option.value || 'qualquer'} className="radio">
          <input type="radio" name={name} checked={choice === option.value} onChange={() => setChoice(option.value)} />
          <span className="dot" />
          {option.label}
        </label>
      ))}
      {choice === 'intervalo' && (
        <div className={styles.range}>
          <label className="field">
            <span className="field-label">{t('from')}</span>
            <input className="input" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">{t('to')}</span>
            <input className="input" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
        </div>
      )}
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={() =>
          onApply(choice === 'intervalo' ? { period: '', from, to } : { period: choice, from: '', to: '' })
        }
      >
        {t('apply')}
      </button>
    </div>
  )
}

function SelectEditor({
  label,
  value,
  options,
  onApply,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onApply: (value: string) => void
}) {
  const { t } = useTranslation('search')
  const [chosen, setChosen] = useState(value)
  return (
    <div className={styles.editor}>
      <select className="input" aria-label={label} value={chosen} onChange={(event) => setChosen(event.target.value)}>
        <option value="">{t('anyOption')}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => onApply(chosen)}>
        {t('apply')}
      </button>
    </div>
  )
}

function TextEditor({ label, value, onApply }: { label: string; value: string; onApply: (value: string) => void }) {
  const { t } = useTranslation('search')
  const [text, setText] = useState(value)
  return (
    <form
      className={styles.editor}
      onSubmit={(event) => {
        event.preventDefault()
        onApply(text.trim())
      }}
    >
      <input
        className="input"
        aria-label={label}
        placeholder={t('anyValue')}
        value={text}
        autoFocus
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="btn btn-primary btn-sm">
        {t('apply')}
      </button>
    </form>
  )
}

function FieldChip({
  field,
  filters,
  onChange,
}: {
  field: Schemas['Field']
  filters: SearchFilters
  onChange: (next: Partial<SearchFilters>) => void
}) {
  const { t } = useTranslation('search')
  const prefix = `${field.id}:`
  const current = filters.field.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? ''
  const apply = (value: string) =>
    onChange({
      field: [...filters.field.filter((item) => !item.startsWith(prefix)), ...(value ? [prefix + value] : [])],
    })
  return (
    <FilterChip label={field.name} value={current || t('any')} active={current !== ''}>
      {(close) =>
        field.kind === 'choice' ? (
          <SelectEditor
            label={field.name}
            value={current}
            options={field.options.map((option) => ({ value: option, label: option }))}
            onApply={(value) => {
              apply(value)
              close()
            }}
          />
        ) : (
          <TextEditor
            label={field.name}
            value={current}
            onApply={(value) => {
              apply(value)
              close()
            }}
          />
        )
      }
    </FilterChip>
  )
}

function Chips({ filters, onChange }: { filters: SearchFilters; onChange: (next: Partial<SearchFilters>) => void }) {
  const { t } = useTranslation('search')
  const people = usePeopleOptions()
  const tags = useTags()
  const collections = useCollections()
  const fields = useUserFields()
  const personName = people.data?.items.find((person) => person.id === filters.person)?.name
  const collectionName = collections.data?.items.find((item) => item.id === filters.collection)?.name
  const own = (fields.data?.items ?? []).filter((field) => field.builtin === null)
  const periodActive = Boolean(filters.period || filters.from || filters.to)

  return (
    <>
      <FilterChip label={t('chip.period')} value={periodValue(filters)} active={periodActive}>
        {(close) => (
          <PeriodEditor
            filters={filters}
            onApply={(next) => {
              onChange(next)
              close()
            }}
          />
        )}
      </FilterChip>
      <FilterChip
        label={t('chip.person')}
        value={filters.person ? (personName ?? t('chosen')) : t('any')}
        active={filters.person !== ''}
      >
        {(close) => (
          <div className={styles.editor}>
            <PersonCombobox
              label={t('chip.person')}
              placeholder={t('personPlaceholder')}
              onSelect={(person) => {
                onChange({ person: person.id })
                close()
              }}
            />
            {filters.person && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  onChange({ person: '' })
                  close()
                }}
              >
                {t('anyPerson')}
              </button>
            )}
          </div>
        )}
      </FilterChip>
      <FilterChip label={t('chip.tag')} value={filters.tag || t('any')} active={filters.tag !== ''}>
        {(close) => (
          <SelectEditor
            label={t('chip.tag')}
            value={filters.tag}
            options={(tags.data?.items ?? []).map((tag) => ({ value: tag.name, label: t('tagOption', { name: tag.name, count: tag.count }) }))}
            onApply={(tag) => {
              onChange({ tag })
              close()
            }}
          />
        )}
      </FilterChip>
      <FilterChip
        label={t('chip.collection')}
        value={filters.collection ? (collectionName ?? t('chosen')) : t('any')}
        active={filters.collection !== ''}
      >
        {(close) => (
          <SelectEditor
            label={t('chip.collection')}
            value={filters.collection}
            options={(collections.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))}
            onApply={(collection) => {
              onChange({ collection })
              close()
            }}
          />
        )}
      </FilterChip>
      {own.map((field) => (
        <FieldChip key={field.id} field={field} filters={filters} onChange={onChange} />
      ))}
    </>
  )
}

function Group({ group }: { group: HitGroup }) {
  const { t } = useTranslation('search')
  const location = useLocation()
  const from = `${location.pathname}${location.search}`
  const recordingId = group.transcript.recording_id
  const speakers = [...new Map(group.hits.map((hit) => [hit.speaker.id, hit.speaker])).values()]
  return (
    <section className={styles.group} aria-label={group.transcript.title}>
      <div className="day-group-head">
        <b>
          <Link to={`/gravacoes/${recordingId}`} state={{ from }}>
            {group.transcript.title}
          </Link>
        </b>
        <span className="text-muted">{shortDayLabel(new Date(group.transcript.recorded_at))}</span>
      </div>
      <div role="list" aria-label={t('passagesOf', { title: group.transcript.title })}>
        {group.hits.map((hit) => {
          const clock = hms(hit.segment.start_ms)
          const who = speakerName(hit.speaker)
          return (
            <div key={hit.segment.id} className={`segment ${styles.hit}`} role="listitem">
              <div className="segment-who">
                <span className={`speaker speaker-${speakerColorIndex(speakers, hit.speaker.id)}`}>{who}</span>
                <Link
                  to={recordingAt(recordingId, hit.segment.start_ms)}
                  state={{ from }}
                  className="timecode"
                  aria-label={t('listen', { time: clock, name: who, title: group.transcript.title })}
                >
                  {clock}
                </Link>
              </div>
              <p className="segment-text">
                {parseHighlight(hit.highlight).map((part, index) =>
                  part.marked ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
                )}
              </p>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function SearchPage() {
  useHelpTopic('busca')
  const { t } = useTranslation(['search', 'common'])
  const [params, setParams] = useSearchParams()
  const filters = filtersFromParams(params)
  const searchable = isSearchable(filters)
  const query = apiQuery(filters)
  const [text, setText] = useState(filters.q)
  const [lastQ, setLastQ] = useState(filters.q)
  // The URL rules: a new term coming from it (back, link) replaces what was typed.
  if (filters.q !== lastQ) {
    setLastQ(filters.q)
    setText(filters.q)
  }
  const results = useInfiniteQuery({
    queryKey: ['search', query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/search', {
          params: { query: { ...query, limit: 25, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    enabled: searchable,
  })
  const hits = results.data?.pages.flatMap((page) => page.items) ?? []
  const change = (next: Partial<SearchFilters>) => setParams(paramsFromFilters({ ...filters, ...next }))

  function submit(event: FormEvent) {
    event.preventDefault()
    change({ q: text })
  }

  return (
    <div className={styles.page}>
      <PageHead kicker={t('kicker')} title={t('title')} />
      <form className={`toolbar ${styles.searchBar}`} role="search" onSubmit={submit}>
        <input
          className={`input ${styles.terms}`}
          type="search"
          aria-label={t('terms')}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="btn btn-primary">
          <Search size={16} aria-hidden />
          {t('submit')}
        </button>
      </form>
      <div className={`toolbar ${styles.chips}`} role="group" aria-label={t('filters')}>
        <Chips filters={filters} onChange={change} />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setParams(paramsFromFilters({ ...EMPTY_FILTERS, q: filters.q }))}
        >
          {t('clear')}
        </button>
        {searchable && results.isSuccess && (
          <span className={`text-muted ${styles.total}`} role="status">
            {totalLabel(hits, results.hasNextPage)}
          </span>
        )}
      </div>

      {!searchable && (
        <p className="text-muted">
          {t('hint')}
        </p>
      )}
      {searchable && results.isPending && <p role="status">{t('searching')}</p>}
      {results.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(results.error)}
        </p>
      )}
      {searchable && results.isSuccess && hits.length === 0 && (
        <p className={`card ${styles.empty}`}>{t('empty')}</p>
      )}
      {hits.length > 0 && (
        <div role="region" aria-label={t('results')}>
          {groupHits(hits).map((group, index) => (
            <Group key={`${group.transcript.id}-${index}`} group={group} />
          ))}
        </div>
      )}
      {results.hasNextPage && (
        <button
          type="button"
          className={`btn btn-secondary ${styles.more}`}
          onClick={() => results.fetchNextPage()}
          disabled={results.isFetchingNextPage}
        >
          {results.isFetchingNextPage ? t('common:loading') : t('more')}
        </button>
      )}
    </div>
  )
}
