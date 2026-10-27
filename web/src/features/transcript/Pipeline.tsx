import { useState } from 'react'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { useCancelTranscription } from './queries'
import { stepLabel, stepNote } from './steps'
import { RetryTranscription } from './RetryTranscription'
import { AwaitingSpeakers } from './AwaitingSpeakers'
import styles from './RecordingPage.module.css'
import { stageLabel } from '../../shared/format'
import { fraseDaEspera } from '../../lib/vocabulario.js'

type Recording = Schemas['Recording']

/** "Cancelar transcrição", with confirmation: the GPU stops and the recording is left without text. */
function CancelTranscription({ recording }: { recording: Recording }) {
  const cancel = useCancelTranscription(recording.id)
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(true)}>
        Cancelar transcrição
      </button>
      {cancel.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(cancel.error)}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          title="Cancelar a transcrição?"
          confirmLabel="Parar a transcrição"
          busy={cancel.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => cancel.mutate(undefined, { onSettled: () => setConfirming(false) })}
        >
          A transcrição para e a gravação fica sem texto. Você pode transcrever de novo quando quiser.
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
  const job = recording.job
  if (recording.status === 'queued') {
    return (
      <>
        <p className={styles.pipelineNote} role="status">
          {fraseDaEspera(job?.queue) ?? 'Aguardando a vez na fila de transcrição.'}
        </p>
        <CancelTranscription recording={recording} />
      </>
    )
  }
  if (recording.status !== 'processing' || !job) return null
  const percent = Math.round(job.progress * 100)
  const stage = stageLabel(job.stage) ?? 'Transcrevendo'
  return (
    <div className={styles.progress}>
      <progress className="progress" max={100} value={percent} aria-label={`${stage}: ${percent}%`} />
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
  const notes = recording.pipeline
    .map((step) => ({ step, note: stepNote(step) }))
    .filter((item): item is { step: Recording['pipeline'][number]; note: string } => item.note !== null)
  return (
    <div className={styles.pipeline}>
      <ol className="pipeline" aria-label="Processamento">
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
        <ul className={styles.pipelineReasons} aria-label="Motivos das etapas">
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
          {recording.job?.error?.message ?? 'A transcrição falhou.'}
        </p>
      )}
      <RetryTranscription recording={recording} />
    </div>
  )
}
