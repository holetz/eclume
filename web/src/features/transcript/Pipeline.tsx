import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { useCancelTranscription } from './queries'
import { stepLabel, stepNote } from './steps'
import { RetryTranscription } from './RetryTranscription'
import { AwaitingSpeakers } from './AwaitingSpeakers'
import styles from './RecordingPage.module.css'
import { stageLabel, waitingPhrase } from '../../shared/format'

type Recording = Schemas['Recording']

/** "Cancelar transcrição", with confirmation: the GPU stops and the recording is left without text. */
function CancelTranscription({ recording }: { recording: Recording }) {
  const { t } = useTranslation('transcript')
  const cancel = useCancelTranscription(recording.id)
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(true)}>
        {t('pipeline.cancel')}
      </button>
      {cancel.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(cancel.error)}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          title={t('pipeline.cancelTitle')}
          confirmLabel={t('pipeline.cancelConfirm')}
          busy={cancel.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => cancel.mutate(undefined, { onSettled: () => setConfirming(false) })}
        >
          {t('pipeline.cancelText')}
        </ConfirmDialog>
      )}
    </>
  )
}

/**
 * In the queue, why the recording waits (`job.queue`); running, the worker's progress: step and %, in
 * the DS `.progress-row`.
 */
function TranscriptionProgress({ recording }: { recording: Recording }) {
  const { t } = useTranslation(['transcript', 'shared'])
  const job = recording.job
  if (recording.status === 'queued') {
    return (
      <>
        <p className={styles.pipelineNote} role="status">
          {waitingPhrase(job?.queue) ?? t('shared:queue.waiting')}
        </p>
        <CancelTranscription recording={recording} />
      </>
    )
  }
  if (recording.status !== 'processing' || !job) return null
  const percent = Math.round(job.progress * 100)
  const stage = stageLabel(job.stage) ?? t('pipeline.transcribing')
  return (
    <div className={styles.progress}>
      <progress className="progress" max={100} value={percent} aria-label={t('pipeline.progress', { stage, percent })} />
      <div className="progress-row">
        <span>{stage}</span>
        <span>{percent}%</span>
      </div>
      <CancelTranscription recording={recording} />
    </div>
  )
}

/**
 * The `ol.pipeline` with the seven steps, each with its state in words; below, the reason for each
 * step skipped, waiting or failed in visible text, the notice of the wait for the speakers, the
 * transcription progress or the failure with the retry.
 */
export function Pipeline({ recording }: { recording: Recording }) {
  const { t } = useTranslation('transcript')
  const notes = recording.pipeline
    .map((step) => ({ step, note: stepNote(step) }))
    .filter((item): item is { step: Recording['pipeline'][number]; note: string } => item.note !== null)
  return (
    <div className={styles.pipeline}>
      <ol className="pipeline" aria-label={t('pipeline.label')}>
        {recording.pipeline.map((step) => (
          <li
            key={step.step}
            data-state={step.state}
            aria-current={step.state === 'active' ? 'step' : undefined}
            title={stepNote(step) ?? undefined}
          >
            {stepLabel(step)}
          </li>
        ))}
      </ol>
      {notes.length > 0 && (
        <ul className={styles.pipelineReasons} aria-label={t('pipeline.reasons')}>
          {notes.map(({ step, note }) => (
            <li key={step.step}>
              {stepLabel(step)}: {note}
            </li>
          ))}
        </ul>
      )}
      <AwaitingSpeakers recording={recording} />
      <TranscriptionProgress recording={recording} />
      {recording.status === 'failed' && (
        <p className="alert alert-error" role="alert">
          {recording.job?.error?.message ?? t('pipeline.failed')}
        </p>
      )}
      <RetryTranscription recording={recording} />
    </div>
  )
}
