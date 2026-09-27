import type { Schemas } from '../../api/client'
import { recordingState, stageLabel } from './format'
import styles from './RecordingStatus.module.css'

type Recording = Schemas['Recording']

/** O estado da gravação em palavra (`recordingState`), com o aviso "Sem resumo" quando a etapa falhou. */
export function StatusBadge({ recording }: { recording: Pick<Recording, 'status' | 'pipeline'> }) {
  const { label, tone, noSummary } = recordingState(recording)
  return (
    <>
      <span className={`badge badge-${tone}`}>{label}</span>
      {noSummary && <span className="badge badge-warning">Sem resumo</span>}
    </>
  )
}

/** Progresso do job: etapa, barra e erro. Nada quando não há job para mostrar. */
export function JobProgress({ recording }: { recording: Recording }) {
  const job = recording.job
  if (recording.status === 'failed') {
    return (
      <p className={styles.error}>
        {job?.error?.message ?? 'A transcrição falhou.'}
        {job?.error?.code && <span className={styles.code}> ({job.error.code})</span>}
      </p>
    )
  }
  if (recording.status === 'queued') {
    return <p className={styles.detail}>Aguardando a vez na fila de transcrição.</p>
  }
  if (recording.status !== 'processing' || !job) return null
  const percent = Math.round(job.progress * 100)
  const stage = stageLabel(job.stage) ?? 'Processando'
  return (
    <div className={styles.progress}>
      <div className={styles.detail}>
        <span>{stage}</span>
        <span className="tabular">{percent}%</span>
      </div>
      <progress className="progress" max={100} value={percent} aria-label={`${stage}: ${percent}%`} />
    </div>
  )
}
