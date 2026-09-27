import { useInfiniteQuery } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { usePageTitle } from '../../app/usePageTitle'
import { useCollections, useTags } from '../collections/queries'
import { formatDate } from '../library/format'
import { recordingAt, usePeopleOptions } from '../people/queries'
import { formatClock, speakerName } from '../transcript/segments'
import { apiQuery, filtersFromParams, isSearchable, paramsFromFilters, type SearchFilters } from './filters'
import { parseHighlight } from './highlight'
import styles from './SearchPage.module.css'

export function SearchPage() {
  usePageTitle('Busca')
  const [params, setParams] = useSearchParams()
  const filters = filtersFromParams(params)
  const searchable = isSearchable(filters)
  const query = apiQuery(filters)
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

  return (
    <section className={styles.page} aria-labelledby="busca-titulo">
      <header>
        <h1 id="busca-titulo">Busca</h1>
        <p className="text-muted">
          Procure o que foi dito nas transcrições que você pode ver. Use aspas para frase exata e - para excluir um
          termo.
        </p>
      </header>

      <SearchForm
        key={params.toString()}
        initial={filters}
        onSubmit={(next) => setParams(paramsFromFilters(next))}
      />

      {!searchable && <p className="text-muted">Digite um termo ou escolha uma pessoa para buscar.</p>}
      {searchable && results.isPending && <p role="status">Buscando…</p>}
      {results.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(results.error)}
        </p>
      )}
      {searchable && results.isSuccess && (
        <p className="visually-hidden" role="status">
          {hits.length === 0 ? 'Nenhum trecho encontrado.' : `${hits.length} trechos encontrados.`}
        </p>
      )}
      {searchable && results.isSuccess && hits.length === 0 && (
        <p className={`card ${styles.empty}`}>Nenhum trecho encontrado com esses filtros.</p>
      )}
      {hits.length > 0 && (
        <ol className={styles.results} aria-label="Resultados">
          {hits.map((hit) => (
            <Hit key={`${hit.transcript.id}/${hit.segment.id}`} hit={hit} />
          ))}
        </ol>
      )}
      {results.hasNextPage && (
        <button
          type="button"
          className={`btn btn-secondary ${styles.more}`}
          onClick={() => results.fetchNextPage()}
          disabled={results.isFetchingNextPage}
        >
          {results.isFetchingNextPage ? 'Carregando…' : 'Mais resultados'}
        </button>
      )}
    </section>
  )
}

function SearchForm({ initial, onSubmit }: { initial: SearchFilters; onSubmit: (filters: SearchFilters) => void }) {
  const [filters, setFilters] = useState(initial)
  const id = useId()
  const people = usePeopleOptions()
  const tags = useTags()
  const collections = useCollections()

  function set<K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value }))
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    onSubmit(filters)
  }

  return (
    <form className={`card ${styles.form}`} role="search" onSubmit={submit}>
      <div className={styles.queryRow}>
        <div className="field">
          <label htmlFor={`${id}-q`}>Termos</label>
          <input
            id={`${id}-q`}
            className="input"
            type="search"
            value={filters.q}
            onChange={(e) => set('q', e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-primary">
          Buscar
        </button>
      </div>
      <fieldset className={styles.filters}>
        <legend className="visually-hidden">Filtros</legend>
        <div className="field">
          <label htmlFor={`${id}-pessoa`}>Pessoa</label>
          <select
            id={`${id}-pessoa`}
            className="input"
            value={filters.person}
            onChange={(e) => set('person', e.target.value)}
          >
            <option value="">Qualquer pessoa</option>
            {people.data?.items.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-de`}>De</label>
          <input id={`${id}-de`} className="input" type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-ate`}>Até</label>
          <input id={`${id}-ate`} className="input" type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-tag`}>Tag</label>
          <select id={`${id}-tag`} className="input" value={filters.tag} onChange={(e) => set('tag', e.target.value)}>
            <option value="">Qualquer tag</option>
            {tags.data?.items.map((tag) => (
              <option key={tag.name} value={tag.name}>
                {tag.name} ({tag.count})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-colecao`}>Coleção</label>
          <select
            id={`${id}-colecao`}
            className="input"
            value={filters.collection}
            onChange={(e) => set('collection', e.target.value)}
          >
            <option value="">Qualquer coleção</option>
            {collections.data?.items.map((collection) => (
              <option key={collection.id} value={collection.id}>
                {collection.name}
              </option>
            ))}
          </select>
        </div>
      </fieldset>
    </form>
  )
}

function Hit({ hit }: { hit: Schemas['SearchHit'] }) {
  const clock = formatClock(hit.segment.start_ms)
  const who = speakerName(hit.speaker)
  return (
    <li className={`card ${styles.hit}`}>
      <p className={styles.hitHead}>
        <Link
          to={recordingAt(hit.transcript.recording_id, hit.segment.start_ms)}
          className={styles.hitTitle}
          aria-label={`${hit.transcript.title}, ${who} em ${clock}`}
        >
          {hit.transcript.title}
        </Link>
        <span>{formatDate(hit.transcript.recorded_at)}</span>
        <span>{who}</span>
        <span className="tabular">{clock}</span>
      </p>
      <p className={styles.text}>
        {parseHighlight(hit.highlight).map((part, index) =>
          part.marked ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
        )}
      </p>
    </li>
  )
}
