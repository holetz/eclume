import { Link, useParams } from 'react-router'
import { errorMessage } from '../../api/problem'
import { usePageTitle } from '../../app/usePageTitle'
import { formatDateTime, formatDuration, sourceLabel } from '../library/format'
import { JobProgress, StatusBadge } from '../library/RecordingStatus'
import { useRecording, useTranscript } from './queries'
import styles from './RecordingPage.module.css'
import { TranscriptView } from './TranscriptView'

export function RecordingPage() {
  const { id = '' } = useParams()
  const recording = useRecording(id)
  const transcript = useTranscript(recording.data?.transcript_id ?? null)
  usePageTitle(recording.data?.title ?? 'Gravação')

  if (recording.isPending) return <p role="status">Carregando gravação…</p>
  if (recording.isError) {
    return (
      <section className={styles.page}>
        <Link to="/" className={styles.back}>
          ← Biblioteca
        </Link>
        <p className="alert alert-error" role="alert">
          {errorMessage(recording.error)}
        </p>
      </section>
    )
  }

  const data = recording.data
  return (
    <section className={styles.page} aria-labelledby="gravacao-titulo">
      <header className={styles.header}>
        <Link to="/" className={styles.back}>
          ← Biblioteca
        </Link>
        <div className={styles.titleRow}>
          <h1 id="gravacao-titulo">{data.title}</h1>
          <StatusBadge status={data.status} />
        </div>
        <p className={styles.meta}>
          <span>{formatDateTime(data.recorded_at)}</span>
          <span className="tabular">{formatDuration(data.duration_ms)}</span>
          <span>{sourceLabel(data.source)}</span>
          {data.language && <span>{data.language}</span>}
          <span>{data.owner.name}</span>
        </p>
        <JobProgress recording={data} />
      </header>

      {data.transcript_id === null ? (
        <p className={`card ${styles.pending}`}>
          {data.status === 'failed'
            ? 'Não há transcrição: o job falhou.'
            : 'A transcrição aparece aqui assim que o processamento terminar.'}
        </p>
      ) : transcript.isPending ? (
        <p role="status">Carregando transcrição…</p>
      ) : transcript.isError ? (
        <p className="alert alert-error" role="alert">
          {errorMessage(transcript.error)}
        </p>
      ) : (
        <div className={styles.layout}>
          <div className={styles.main}>
            <TranscriptView recordingId={data.id} transcript={transcript.data} />
          </div>
        </div>
      )}
    </section>
  )
}
