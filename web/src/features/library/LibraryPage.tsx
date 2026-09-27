import { useInfiniteQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { usePageTitle } from '../../app/usePageTitle'
import { useCollections } from '../collections/queries'
import { formatDateTime, formatDuration, isActive, sourceLabel } from './format'
import styles from './LibraryPage.module.css'
import { JobProgress, StatusBadge } from './RecordingStatus'

const POLL_MS = 3000

export function LibraryPage() {
  usePageTitle('Biblioteca')
  const [params] = useSearchParams()
  const collection = params.get('colecao')
  const tag = params.get('tag')
  const collections = useCollections(collection !== null)
  const collectionName = collections.data?.items.find((c) => c.id === collection)?.name

  const recordings = useInfiniteQuery({
    queryKey: ['recordings', { collection, tag }],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/recordings', {
          params: {
            query: {
              limit: 25,
              ...(collection ? { collection } : {}),
              ...(tag ? { tag } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    // Enquanto algum job anda, a lista se atualiza sozinha.
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.items.some(isActive)) ? POLL_MS : false,
  })

  const items = recordings.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <section className={styles.page} aria-labelledby="biblioteca-titulo">
      <header className={styles.header}>
        <div>
          <h1 id="biblioteca-titulo">Biblioteca</h1>
          <p className="text-muted">Suas gravações.</p>
        </div>
        <Link to="/importar" className="btn btn-primary">
          Importar arquivo
        </Link>
      </header>

      {(collection || tag) && (
        <p className={styles.active}>
          {collection && <span>Coleção: {collectionName ?? 'carregando…'}</span>}
          {tag && <span>Tag: {tag}</span>}
          <Link to="/">Limpar filtro</Link>
        </p>
      )}

      {recordings.isPending && <p role="status">Carregando gravações…</p>}
      {recordings.isError && (
        <div className="alert alert-error" role="alert">
          {errorMessage(recordings.error)}{' '}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => recordings.refetch()}>
            Tentar de novo
          </button>
        </div>
      )}
      {recordings.isSuccess && items.length === 0 && <EmptyLibrary />}

      {items.length > 0 && (
        <ul className={styles.list} aria-label="Gravações">
          {items.map((recording) => (
            <RecordingRow key={recording.id} recording={recording} />
          ))}
        </ul>
      )}

      {recordings.hasNextPage && (
        <button
          type="button"
          className={`btn btn-secondary ${styles.more}`}
          onClick={() => recordings.fetchNextPage()}
          disabled={recordings.isFetchingNextPage}
        >
          {recordings.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
        </button>
      )}
    </section>
  )
}

function RecordingRow({ recording }: { recording: Schemas['Recording'] }) {
  return (
    <li className={`card ${styles.row}`}>
      <div className={styles.main}>
        <h2 className={styles.title}>
          <Link to={`/gravacoes/${recording.id}`}>{recording.title}</Link>
        </h2>
        <p className={styles.meta}>
          <span>{formatDateTime(recording.recorded_at)}</span>
          <span className="tabular">{formatDuration(recording.duration_ms)}</span>
          <span>{sourceLabel(recording.source)}</span>
        </p>
        <JobProgress recording={recording} />
      </div>
      <StatusBadge status={recording.status} />
    </li>
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
        Importar arquivo
      </Link>
    </div>
  )
}
