import { useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { usePageTitle } from '../../app/usePageTitle'
import { ChatPanel } from './ChatPanel'
import { FieldsPanel } from './FieldsPanel'
import { MarkerBar } from './MarkerBar'
import { useMarkers } from './markers'
import { Pipeline } from './Pipeline'
import { PlaybackProvider } from './PlaybackProvider'
import { Player } from './Player'
import { useRecording, useRefreshOnPipeline, useTranscript } from './queries'
import { RecordingHeader } from './RecordingHeader'
import styles from './RecordingPage.module.css'
import { parseStart } from './segments'
import { useSummaryState } from './summary'
import { SpeakersDisclosure } from './SpeakersDisclosure'
import { ChangeTypeDialog, SummaryDoc } from './SummaryDoc'
import { TranscriptDisclosure } from './TranscriptDisclosure'

/** A URL da biblioteca de onde a pessoa veio (calendário, lista ou busca); sem ela, a biblioteca. */
function useBackTo(): string {
  const { state } = useLocation()
  const from = (state as { from?: unknown } | null)?.from
  return typeof from === 'string' && from.startsWith('/') ? from : '/'
}

export function RecordingPage() {
  useHelpTopic('gravacao')
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const backTo = useBackTo()
  const startMs = parseStart(params.get('t'))
  const recording = useRecording(id)
  const transcript = useTranscript(recording.data?.transcript_id ?? null)
  // Com `?t=` (vindo da busca), a transcrição já abre na fala.
  const [transcriptOpen, setTranscriptOpen] = useState(startMs !== null)
  const [speakersOpen, setSpeakersOpen] = useState(false)
  const [changingType, setChangingType] = useState(false)
  const summary = useSummaryState(id, Boolean(recording.data?.transcript_id))
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
          hasSummary={Boolean(summary.data?.current)}
          onDeleted={() => navigate(backTo, { state: { notice: 'Gravação excluída.' } })}
        />
        <Pipeline recording={data} />

        <PlaybackProvider recordingId={data.id} durationMs={data.duration_ms} startMs={startMs}>
          {data.transcript_id !== null && (
            <>
              {/* Fixo abaixo do cabeçalho: pausar fica a um clique em qualquer ponto da página. */}
              <div className={styles.playerDock}>
                <Player markers={markers.data ?? []} />
              </div>
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
              <SpeakersDisclosure transcript={transcript.data} open={speakersOpen} onOpenChange={setSpeakersOpen} />
              <TranscriptDisclosure
                transcript={transcript.data}
                markers={markers.data ?? []}
                recordingId={data.id}
                anchorMs={startMs}
                open={transcriptOpen}
                onOpenChange={setTranscriptOpen}
              />
            </>
          )}
        </PlaybackProvider>

        {data.transcript_id !== null && (
          <div className={styles.docGrid}>
            <SummaryDoc recording={data} onChangeType={() => setChangingType(true)} />
            <FieldsPanel recording={data} onChangeType={() => setChangingType(true)} />
          </div>
        )}
        {changingType && <ChangeTypeDialog recording={data} onClose={() => setChangingType(false)} />}
      </div>
      <ChatPanel
        recordingId={data.id}
        hasTranscript={data.transcript_id !== null}
        hasSummary={Boolean(summary.data?.current)}
        agendaTypeId={data.agenda_type?.id ?? null}
        className={styles.chat}
      />
    </div>
  )
}
