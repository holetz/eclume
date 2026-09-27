import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useId } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { PageHead } from '../../app/PageHead'
import { addDays, dayKey, parseDayKey, weekRange, weekTitle } from './calendar'
import { CalendarWeek } from './CalendarWeek'
import { activeFilterCount, readFilters, readView, type LibraryView } from './filters'
import styles from './LibraryPage.module.css'
import { useLibraryRange } from './queries'

const VIEWS: { value: LibraryView; label: string }[] = [
  { value: 'mes', label: 'Mês' },
  { value: 'semana', label: 'Semana' },
  { value: 'lista', label: 'Lista' },
]

/** Se a conta tem alguma gravação: decide entre "nada neste período" e a biblioteca vazia. */
function useHasAnyRecording(enabled: boolean) {
  return useQuery({
    queryKey: ['recordings', 'any'],
    enabled,
    queryFn: () => unwrap(api.GET('/api/v1/recordings', { params: { query: { limit: 1 } } })),
    select: (page) => page.items.length > 0,
  })
}

export function LibraryPage() {
  const [params, setParams] = useSearchParams()
  const segId = useId()
  const view = readView(params) ?? 'semana'
  const day = parseDayKey(params.get('data')) ?? new Date()
  const filters = readFilters(params)
  const week = weekRange(day)
  const range = useLibraryRange(week, filters)
  const items = range.data?.items ?? []
  const emptyPeriod = range.isSuccess && items.length === 0
  const anyRecording = useHasAnyRecording(emptyPeriod && activeFilterCount(filters) === 0)
  const emptyLibrary = anyRecording.data === false

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key)
      else next.set(key, value)
    }
    setParams(next)
  }

  const moveBy = (days: number) => update({ data: dayKey(addDays(week.from, days)) })

  return (
    <div className={`bleed ${styles.layout}`}>
      <div className={styles.content}>
        <PageHead
          kicker="Gravações"
          title="Biblioteca"
          actions={
            <>
              <Link to="/busca" className="btn btn-secondary">
                <Search size={16} aria-hidden />
                Buscar
              </Link>
              <Link to="/importar" className="btn btn-primary">
                Importar arquivos
              </Link>
            </>
          }
        />

        <div className={`toolbar ${styles.toolbar}`}>
          <span className="toolbar-title" aria-live="polite">
            {weekTitle(week.from)}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            aria-label="Semana anterior"
            onClick={() => moveBy(-7)}
          >
            <ChevronLeft size={16} aria-hidden />
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => update({ data: dayKey(new Date()) })}>
            Hoje
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            aria-label="Próxima semana"
            onClick={() => moveBy(7)}
          >
            <ChevronRight size={16} aria-hidden />
          </button>
          <div className="seg" role="radiogroup" aria-label="Visão">
            {VIEWS.map((option) => (
              <label key={option.value} className="seg-opt">
                <input
                  type="radio"
                  name={segId}
                  value={option.value}
                  checked={view === option.value}
                  onChange={() => update({ visao: option.value })}
                />
                {option.label}
              </label>
            ))}
          </div>
        </div>

        {range.isError && (
          <div className="alert alert-error" role="alert">
            {errorMessage(range.error)}{' '}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => range.refetch()}>
              Tentar de novo
            </button>
          </div>
        )}
        {range.isPending && (
          <p role="status" className={styles.status}>
            Carregando gravações…
          </p>
        )}
        {range.data?.truncated && (
          <p role="status" className={styles.status}>
            Mostrando as primeiras 1000 gravações deste período.
          </p>
        )}

        {emptyLibrary ? (
          <EmptyLibrary />
        ) : (
          <>
            <CalendarWeek days={week.days} recordings={items} busy={range.isPending} />
            {emptyPeriod && <p className={`text-muted ${styles.status}`}>Nada gravado neste período.</p>}
          </>
        )}
      </div>
    </div>
  )
}

function EmptyLibrary() {
  return (
    <div className={`card ${styles.empty}`}>
      <h2>Nenhuma gravação ainda</h2>
      <p className="text-muted">
        Importe um arquivo de áudio ou vídeo, ou instale o <Link to="/app-desktop">app desktop</Link> para gravar
        reuniões automaticamente.
      </p>
      <Link to="/importar" className="btn btn-primary">
        Importar arquivos
      </Link>
    </div>
  )
}
