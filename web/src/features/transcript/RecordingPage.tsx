import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { errorMessage } from '../../api/problem'
import { usePageTitle } from '../../app/usePageTitle'
import { MarkerBar } from './MarkerBar'
import { useMarkers } from './markers'
import { Pipeline } from './Pipeline'
import { PlaybackProvider } from './PlaybackProvider'
import { Player } from './Player'
import { useRecording, useRefreshOnPipeline, useTranscript } from './queries'
import { RecordingHeader } from './RecordingHeader'
import styles from './RecordingPage.module.css'
import { parseStart } from './segments'
import { SpeakersPanel } from './SpeakersPanel'
import { TranscriptView } from './TranscriptView'

/** A URL da biblioteca de onde a pessoa veio (calendário, lista ou busca); sem ela, a biblioteca. */
function useBackTo(): string {
  const { state } = useLocation()
  const from = (state as { from?: unknown } | null)?.from
  return typeof from === 'string' && from.startsWith('/') ? from : '/'
}

export function RecordingPage() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const backTo = useBackTo()
  const startMs = parseStart(params.get('t'))
  const recording = useRecording(id)
  const transcript = useTranscript(recording.data?.transcript_id ?? null)
  const markers = useMarkers(id, (recording.data?.marker_count ?? 0) > 0)
  useRefreshOnPipeline(recording.data)
  usePageTitle(recording.data?.title ?? 'Gravação')

  const back = (
    <Link to={backTo} className={styles.back}>
      ← Biblioteca
    </Link>
  )

  if (recording.isPending) return <p role="status">Carregando gravação…</p>
  if (recording.isError) {
    return (
      <div className={styles.content}>
        {back}
        <p className="alert alert-error" role="alert">
          {errorMessage(recording.error)}
        </p>
      </div>
    )
  }

  const data = recording.data
  return (
    <div className={`bleed ${styles.layout}`}>
      <div className={styles.content}>
        {back}
        <RecordingHeader
          recording={data}
          hasSummary
          onDeleted={() => navigate(backTo, { state: { notice: 'Gravação excluída.' } })}
        />
        <Pipeline recording={data} />

        <PlaybackProvider recordingId={data.id} durationMs={data.duration_ms} startMs={startMs}>
          {data.transcript_id !== null && (
            <>
              <Player markers={markers.data ?? []} />
              <MarkerBar markers={markers.data ?? []} />
            </>
          )}
          {data.transcript_id === null ? (
            <p className={styles.pending}>
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
            <>
              <SpeakersPanel transcript={transcript.data} />
              <TranscriptView transcript={transcript.data} />
            </>
          )}
        </PlaybackProvider>
      </div>
      <aside className={`chat ${styles.chat}`} aria-label="Ajustar o resumo">
        <div className="chat-head">
          <strong>Ajustar o resumo</strong>
          <span className="text-muted">Trabalha sobre o resumo. Só lê a transcrição quando o pedido precisa.</span>
        </div>
      </aside>
    </div>
  )
}
