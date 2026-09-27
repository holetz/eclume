import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useId } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { PageHead } from '../../app/PageHead'
import { addDays, addMonths, dayKey, monthGrid, monthTitle, parseDayKey, weekRange, weekTitle } from './calendar'
import { CalendarMonth } from './CalendarMonth'
import { CalendarWeek } from './CalendarWeek'
import { activeFilterCount, readFilters, readView, type LibraryView } from './filters'
import styles from './LibraryPage.module.css'
import { useLibraryList, useLibraryRange } from './queries'
import { RecordingList } from './RecordingList'

const VIEWS: { value: LibraryView; label: string }[] = [
  { value: 'mes', label: 'Mês' },
  { value: 'semana', label: 'Semana' },
  { value: 'lista', label: 'Lista' },
]

const NARROW = '(max-width: 56rem)'

/** Em tela estreita, sem visão na URL, a biblioteca abre na lista. */
function defaultView(): LibraryView {
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches ? 'lista' : 'semana'
}

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
  const view = readView(params) ?? defaultView()
  const day = parseDayKey(params.get('data')) ?? new Date()
  const filters = readFilters(params)
  const week = weekRange(day)
  const month = monthGrid(day)
  const range = useLibraryRange(view === 'mes' ? month : week, filters, view !== 'lista')
  const list = useLibraryList(filters, view === 'lista')
  const current = view === 'lista' ? list : range
  const items = (view === 'lista' ? list.data?.pages.flatMap((page) => page.items) : range.data?.items) ?? []
  const emptyPeriod = current.isSuccess && items.length === 0
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

  const step = (direction: 1 | -1) =>
    update({ data: dayKey(view === 'mes' ? addMonths(day, direction) : addDays(week.from, 7 * direction)) })
  const unit = view === 'mes' ? { previous: 'Mês anterior', next: 'Próximo mês' } : { previous: 'Semana anterior', next: 'Próxima semana' }

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
            {view === 'lista' ? 'Todas as gravações' : view === 'mes' ? monthTitle(day) : weekTitle(week.from)}
          </span>
          {view !== 'lista' && (
            <>
              <button
                type="button"
                className="btn btn-secondary btn-icon"
                aria-label={unit.previous}
                onClick={() => step(-1)}
              >
                <ChevronLeft size={16} aria-hidden />
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => update({ data: dayKey(new Date()) })}>
                Hoje
              </button>
              <button type="button" className="btn btn-secondary btn-icon" aria-label={unit.next} onClick={() => step(1)}>
                <ChevronRight size={16} aria-hidden />
              </button>
            </>
          )}
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

        {current.isError && (
          <div className="alert alert-error" role="alert">
            {errorMessage(current.error)}{' '}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => current.refetch()}>
              Tentar de novo
            </button>
          </div>
        )}
        {current.isPending && (
          <p role="status" className={styles.status}>
            Carregando gravações…
          </p>
        )}
        {view !== 'lista' && range.data?.truncated && (
          <p role="status" className={styles.status}>
            Mostrando as primeiras 1000 gravações deste período.
          </p>
        )}

        {emptyLibrary ? (
          <EmptyLibrary />
        ) : (
          <>
            {view === 'semana' && <CalendarWeek days={week.days} recordings={items} busy={range.isPending} />}
            {view === 'mes' && (
              <CalendarMonth
                cells={month.cells}
                recordings={items}
                busy={range.isPending}
                onOpenWeek={(date) => update({ visao: 'semana', data: dayKey(date) })}
              />
            )}
            {view === 'lista' && <RecordingList recordings={items} />}
            {emptyPeriod && (
              <p className={`text-muted ${styles.status}`}>
                {view === 'lista' ? 'Nada gravado.' : 'Nada gravado neste período.'}
              </p>
            )}
            {view === 'lista' && list.hasNextPage && (
              <button
                type="button"
                className={`btn btn-secondary ${styles.more}`}
                onClick={() => list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
              </button>
            )}
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
