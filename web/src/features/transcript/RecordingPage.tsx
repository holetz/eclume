import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { AudioDeletedNotice } from './RetryTranscription'
import { Player } from './Player'
import { useRecording, useRefreshOnPipeline, useTranscript } from './queries'
import { RecordingHeader } from './RecordingHeader'
import styles from './RecordingPage.module.css'
import { parseStart } from './segments'
import { useSummaryState } from './summary'
import { SpeakersDisclosure } from './SpeakersDisclosure'
import { ChangeTypeDialog, SummaryDoc } from './SummaryDoc'
import { TranscriptDisclosure } from './TranscriptDisclosure'

/** The library URL the person came from (calendar, list or search); without it, the library. */
function useBackTo(): string {
  const { state } = useLocation()
  const from = (state as { from?: unknown } | null)?.from
  return typeof from === 'string' && from.startsWith('/') ? from : '/'
}

export function RecordingPage() {
  useHelpTopic('gravacao')
  const { t } = useTranslation('transcript')
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const backTo = useBackTo()
  const startMs = parseStart(params.get('t'))
  const recording = useRecording(id)
  const transcript = useTranscript(recording.data?.transcript_id ?? null)
  // With `?t=` (coming from search), the transcript opens already at the segment.
  const [transcriptOpen, setTranscriptOpen] = useState(startMs !== null)
  const [speakersOpen, setSpeakersOpen] = useState(false)
  const [changingType, setChangingType] = useState(false)
  const summary = useSummaryState(id, Boolean(recording.data?.transcript_id))
  const markers = useMarkers(id, (recording.data?.marker_count ?? 0) > 0)
  useRefreshOnPipeline(recording.data)
  // Stopped waiting for the names (`speakers` step in `waiting`), the Locutores block opens by itself, and the
  // link in the "Aguardando locutores" notice (`#locutores`) reopens it if the person has collapsed it.
  const awaitingSpeakers =
    recording.data?.pipeline.some((step) => step.step === 'speakers' && step.state === 'waiting') ?? false
  // Adjusted during render (not in an effect): on entering the wait, the block opens once.
  const [wasAwaiting, setWasAwaiting] = useState(false)
  if (awaitingSpeakers !== wasAwaiting) {
    setWasAwaiting(awaitingSpeakers)
    if (awaitingSpeakers) setSpeakersOpen(true)
  }
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash === '#locutores') setSpeakersOpen(true)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  usePageTitle(recording.data?.title ?? t('page.title'))

  const back = (
    <Link to={backTo} className={styles.back}>
      {t('page.back')}
    </Link>
  )

  if (recording.isPending) return <p role="status">{t('page.loading')}</p>
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
          onDeleted={() => navigate(backTo, { state: { notice: t('page.deleted') } })}
        />
        <Pipeline recording={data} />

        <PlaybackProvider
          recordingId={data.id}
          durationMs={data.duration_ms}
          startMs={startMs}
          audioDeleted={Boolean(data.audio_deleted_at)}
        >
          {data.transcript_id !== null && (
            <>
              {/* Fixed below the header: pausing is one click away from anywhere on the page. */}
              <div className={styles.playerDock}>
                {data.audio_deleted_at ? <AudioDeletedNotice /> : <Player markers={markers.data ?? []} />}
              </div>
              <MarkerBar markers={markers.data ?? []} />
            </>
          )}
          {data.transcript_id === null ? (
            <p className={styles.pending}>
              {data.status === 'failed'
                ? t('page.noTranscriptFailed')
                : t('page.transcriptPending')}
            </p>
          ) : transcript.isPending ? (
            <p role="status">{t('page.loadingTranscript')}</p>
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
            <SummaryDoc
              recording={data}
              transcriptRevision={transcript.data?.revision}
              onChangeType={() => setChangingType(true)}
            />
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
