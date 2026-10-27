import { useState } from 'react'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { AUTO_LANGUAGE, languageLabel } from '../../lib/languages'

import { ExportMenu } from './ExportMenu'
import { useDeleteRecording } from './queries'
import { RetranscribeAction } from './RetryTranscription'
import styles from './RecordingPage.module.css'
import { formatDuration, shortDayLabel, shortRef, timeLabel } from '../../shared/format'

type Recording = Schemas['Recording']

/**
 * "qui 24 set 2026 · 09:00 · 1 h 12 min · Português", with "· data do envio" when the file did not
 * carry a date; the language is the transcript's, which only shows after detection.
 */
function recordingKicker(
  recording: Pick<Recording, 'recorded_at' | 'recorded_at_source' | 'duration_ms' | 'language'>,
): string {
  const start = new Date(recording.recorded_at)
  const parts = [`${shortDayLabel(start)} ${start.getFullYear()}`, timeLabel(start)]
  if (recording.duration_ms) parts.push(formatDuration(recording.duration_ms))
  if (recording.language && recording.language !== AUTO_LANGUAGE) parts.push(languageLabel(recording.language))
  if (recording.recorded_at_source === 'upload') parts.push('data do envio')
  return parts.join(' · ')
}

interface RecordingHeaderProps {
  recording: Recording
  hasSummary: boolean
  onDeleted: () => void
}

/** Date, time, duration and language in the kicker, the title and the Transcrever de novo em…, Exportar and Excluir actions (frame "Recording"). */
export function RecordingHeader({ recording, hasSummary, onDeleted }: RecordingHeaderProps) {
  const [confirming, setConfirming] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const remove = useDeleteRecording(recording)

  return (
    <header className={styles.header}>
      <div className={styles.titleBlock}>
        <span className="kicker">{recordingKicker(recording)}</span>
        <h1 className={styles.title}>{recording.title}</h1>
        <span className={styles.ref} title={`ID completo: ${recording.id}`}>
          ref. {shortRef(recording.id)}
        </span>
      </div>
      <div className={styles.actions}>
        <RetranscribeAction recording={recording} />
        <ExportMenu recordingId={recording.id} hasSummary={hasSummary} onError={setExportError} />
        <button type="button" className="btn btn-danger btn-secondary" onClick={() => setConfirming(true)}>
          Excluir
        </button>
      </div>
      {exportError && (
        <p className={`alert alert-error ${styles.headerAlert}`} role="alert">
          {exportError}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          title="Excluir a gravação?"
          confirmLabel="Excluir"
          busy={remove.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => remove.mutate(undefined, { onSuccess: onDeleted })}
        >
          <p>
            O áudio, a transcrição, o resumo com as versões, o chat e os marcadores são apagados. Não dá para desfazer.
          </p>
          {remove.isError && (
            <p className="alert alert-error" role="alert">
              {errorMessage(remove.error)}
            </p>
          )}
        </ConfirmDialog>
      )}
    </header>
  )
}
