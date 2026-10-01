import type { Schemas } from '../../api/client'

import { stepLabel, stepNote } from './steps'
import { RetryTranscription } from './RetryTranscription'
import styles from './RecordingPage.module.css'
import { stageLabel } from '../../shared/format'

type Recording = Schemas['Recording']

/** O progresso do worker enquanto a transcrição anda: etapa e %, no `.progress-row` do DS. */
function TranscriptionProgress({ recording }: { recording: Recording }) {
  const job = recording.job
  if (recording.status === 'queued') {
    return <p className={styles.pipelineNote}>Aguardando a vez na fila de transcrição.</p>
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
    </div>
  )
}

/** O `ol.pipeline` com as seis etapas; embaixo, o progresso da transcrição ou a falha com o retentar. */
export function Pipeline({ recording }: { recording: Recording }) {
  return (
    <div className={styles.pipeline}>
      <ol className="pipeline" aria-label="Processamento">
        {recording.pipeline.map((step) => {
          const note = stepNote(step)
          return (
            <li
              key={step.step}
              data-state={step.state}
              aria-current={step.state === 'active' ? 'step' : undefined}
              title={note ?? undefined}
            >
              {stepLabel(step)}
              {note && <span className="visually-hidden"> ({note})</span>}
            </li>
          )
        })}
      </ol>
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
