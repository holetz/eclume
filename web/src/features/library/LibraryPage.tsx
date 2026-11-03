import { ChevronLeft, ChevronRight, Search, SlidersHorizontal } from 'lucide-react'
import { lazy, Suspense, useEffect, useId, useState, useSyncExternalStore } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { errorMessage } from '../../api/problem'
import { Dialog } from '../../app/Dialog'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { readLibraryOpening } from '../../app/preferences'
import { useMe } from '../../app/session'
import { readLastLibrary, readStored, STORAGE_KEYS, writeLastLibrary, writeStored } from '../../app/storage'
import { useImportContext } from '../import/importContext'
import { useSpeakerNaming } from '../people/queries'
import { addDays, addMonths, dayKey, monthGrid, monthTitle, parseDayKey, weekRange, weekTitle } from './calendar'
import { CalendarMonth } from './CalendarMonth'
import { CalendarWeek } from './CalendarWeek'
import { FirstSteps } from './FirstSteps'
import {
  activeFilterCount,
  NO_FILTERS,
  readFilters,
  readView,
  rememberedSearch,
  writeFilters,
  type LibraryFilters as Filters,
  type LibraryView,
} from './filters'
import { FilterGroups, LibraryFilters } from './LibraryFilters'
import styles from './LibraryPage.module.css'
import type { ImportItem } from '../import/useImportQueue'
import { useHasAnyRecording } from './anyRecording'
import { useLibraryList, useLibraryRange } from './queries'
import { RecordingList } from './RecordingList'

const VIEWS: { value: LibraryView; label: string }[] = [
  { value: 'mes', label: 'Mês' },
  { value: 'semana', label: 'Semana' },
  { value: 'lista', label: 'Lista' },
]

// The modal (and the media converter it pulls in) loads only when it opens.
const ImportDialog = lazy(() => import('../import/ImportDialog').then((module) => ({ default: module.ImportDialog })))

const NARROW = '(max-width: 56rem)'

function matchesNarrow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches
}

/** Whether the screen is narrow (below 56rem), following width changes. */
function useNarrow(): boolean {
  return useSyncExternalStore((onChange) => {
    const query = typeof window.matchMedia === 'function' ? window.matchMedia(NARROW) : null
    query?.addEventListener?.('change', onChange)
    return () => query?.removeEventListener?.('change', onChange)
  }, matchesNarrow)
}

export function LibraryPage() {
  useHelpTopic('biblioteca')
  const [params, setParams] = useSearchParams()
  const segId = useId()
  const filtersId = useId()
  const narrow = useNarrow()
  const [collapsed, setCollapsed] = useState(() => readStored(STORAGE_KEYS.filtersCollapsed) === '1')
  const [filtersOpen, setFiltersOpen] = useState(false)
  // The library opened without parameters returns to the last view and the last filters, or opens in the view
  // chosen on the Environment screen. The restore happens only once: the router's `setParams` changes
  // identity on every URL change, and an effect using it without this latch would overwrite every filter.
  const [opening] = useState(readLibraryOpening)
  const userId = useMe().data?.user.id ?? ''
  const [restoring, setRestoring] = useState(
    () => params.size === 0 && (opening !== 'ultima' || Boolean(readLastLibrary(userId))),
  )
  // The restore ends when the restored URL arrives: from then on, a removed filter is a removed filter.
  if (restoring && params.size > 0) setRestoring(false)
  useEffect(() => {
    if (!restoring) return
    const next = opening === 'ultima' ? (readLastLibrary(userId) ?? '') : { visao: opening }
    setParams(new URLSearchParams(next), { replace: true })
  }, [restoring, opening, setParams, userId])
  // Removing the last filter leaves the URL empty: the stored one is cleared too, otherwise it would come back on the next
  // visit. During the restore the empty URL is only the starting one, and the stored one is still to be read.
  useEffect(() => {
    if (restoring) return
    writeLastLibrary(userId, rememberedSearch(params) || null)
  }, [restoring, params, userId])

  // The notice a deleted recording leaves when returning to the library.
  const notice = (useLocation().state as { notice?: string } | null)?.notice
  const importQueue = useImportContext()
  const importing = params.get('importar') === '1'
  const view = readView(params) ?? (narrow ? 'lista' : 'semana')
  const day = parseDayKey(params.get('data')) ?? new Date()
  const filters = readFilters(params)
  const week = weekRange(day)
  const month = monthGrid(day)
  const range = useLibraryRange(view === 'mes' ? month : week, filters, view !== 'lista')
  const list = useLibraryList(filters, view === 'lista')
  const current = view === 'lista' ? list : range
  const items = (view === 'lista' ? list.data?.pages.flatMap((page) => page.items) : range.data?.items) ?? []
  const emptyPeriod = current.isSuccess && items.length === 0
  // Decides between "nothing in this period" and the empty library.
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

  // Opening and closing the Import modal does not stack history: Back does not reopen it.
  function setImporting(open: boolean) {
    const next = new URLSearchParams(params)
    if (open) next.set('importar', '1')
    else next.delete('importar')
    setParams(next, { replace: true })
  }

  const changeFilters = (next: Filters) => setParams(writeFilters(params, next))
  const clearFilters = () => changeFilters(NO_FILTERS)
  const filterCount = activeFilterCount(filters)

  function toggleCollapsed() {
    setCollapsed(!collapsed)
    writeStored(STORAGE_KEYS.filtersCollapsed, collapsed ? null : '1')
  }

  const step = (direction: 1 | -1) =>
    update({ data: dayKey(view === 'mes' ? addMonths(day, direction) : addDays(week.from, 7 * direction)) })
  const unit = view === 'mes' ? { previous: 'Mês anterior', next: 'Próximo mês' } : { previous: 'Semana anterior', next: 'Próxima semana' }

  return (
    <div className={`bleed ${narrow ? '' : 'with-filters'} ${styles.layout}`} data-collapsed={(!narrow && collapsed) || undefined}>
      <div className={`${styles.content} ${view === 'lista' ? '' : styles.fill}`}>
        <PageHead
          kicker="Gravações"
          title="Biblioteca"
          actions={
            <>
              <Link to="/busca" className="btn btn-secondary">
                <Search size={16} aria-hidden />
                Buscar
              </Link>
              <button type="button" className="btn btn-primary" onClick={() => setImporting(true)}>
                Importar arquivos
              </button>
            </>
          }
        />

        {notice && (
          <p className={`alert alert-success ${styles.band}`} role="status">
            {notice}
          </p>
        )}
        <ImportBand items={importQueue.items} onOpen={() => setImporting(true)} />
        {!filters.needs.includes('locutores') && (
          <NeedsYouBand
            onShow={() => {
              const next = writeFilters(params, { ...filters, needs: ['locutores'] })
              next.set('visao', 'lista')
              setParams(next)
            }}
          />
        )}
        <FirstSteps onImport={() => setImporting(true)} />

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
          {narrow && (
            <button type="button" className="btn btn-secondary" onClick={() => setFiltersOpen(true)}>
              <SlidersHorizontal size={16} aria-hidden />
              Filtros ({filterCount})
            </button>
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
          <EmptyLibrary onImport={() => setImporting(true)} />
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
      {!narrow && (
        <LibraryFilters
          id={filtersId}
          collapsed={collapsed}
          onToggle={toggleCollapsed}
          onClear={clearFilters}
          filters={filters}
          onChange={changeFilters}
        />
      )}
      {importing && (
        <Suspense fallback={null}>
          <ImportDialog onClose={() => setImporting(false)} />
        </Suspense>
      )}
      {narrow && filtersOpen && (
        <Dialog
          title="Filtros"
          kicker="Biblioteca"
          plain
          onClose={() => setFiltersOpen(false)}
          actions={
            <>
              <button type="button" className="btn btn-ghost" onClick={clearFilters} disabled={filterCount === 0}>
                Limpar filtros
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setFiltersOpen(false)}>
                Ver gravações
              </button>
            </>
          }
        >
          <div className={styles.dialogGroups}>
            <FilterGroups filters={filters} onChange={changeFilters} />
          </div>
        </Dialog>
      )}
    </div>
  )
}

/** The import queue strip, while a file is converting or uploading. */
function ImportBand({ items, onOpen }: { items: ImportItem[]; onOpen: () => void }) {
  const active = items.filter((item) => item.state.kind !== 'canceled')
  const current = active.findIndex((item) => item.state.kind === 'converting' || item.state.kind === 'uploading')
  if (current === -1) return null
  return (
    <div className={`alert alert-info ${styles.band}`} role="status">
      <span>
        Enviando {current + 1} de {active.length} {active.length === 1 ? 'arquivo' : 'arquivos'} ·{' '}
        <button type="button" className={styles.linkButton} onClick={onOpen}>
          Abrir
        </button>
      </span>
    </div>
  )
}

/**
 * "Precisam de você": how many recordings wait for you to name the speakers (the account requires it), with the
 * shortcut that turns the filter on in the list.
 */
function NeedsYouBand({ onShow }: { onShow: () => void }) {
  const naming = useSpeakerNaming()
  const count = naming.data?.waiting_count ?? 0
  if (count === 0) return null
  return (
    <div className={`alert alert-warning ${styles.band}`} role="status" aria-label="Precisam de você">
      <span>
        {count === 1
          ? '1 gravação aguarda você nomear os locutores para seguir com o tipo, os campos e o resumo'
          : `${count} gravações aguardam você nomear os locutores para seguir com o tipo, os campos e o resumo`}{' '}
        ·{' '}
        <button type="button" className={styles.linkButton} onClick={onShow}>
          Ver
        </button>
      </span>
    </div>
  )
}

function EmptyLibrary({ onImport }: { onImport: () => void }) {
  return (
    <div className={`card ${styles.empty}`}>
      <h2>Nenhuma gravação ainda</h2>
      <p className="text-muted">
        Importe um arquivo de áudio ou vídeo, grave reuniões automaticamente com o{' '}
        <Link to="/app-desktop">app desktop</Link> ou grave pelo <Link to="/app-movel">app do celular</Link>. Cada
        gravação é transcrita, ganha título e resumo pelo seu{' '}
        <Link to="/config/agendas">tipo de agenda</Link>.
      </p>
      <button type="button" className="btn btn-primary" onClick={onImport}>
        Importar arquivos
      </button>
    </div>
  )
}
