import type { Schemas } from '../../api/client'
import { recordingState } from '../../shared/format'

type Recording = Schemas['Recording']

/** The recording status in a word (`recordingState`), with the "Sem resumo" notice when the step failed. */
export function StatusBadge({ recording }: { recording: Pick<Recording, 'status' | 'pipeline'> }) {
  const { label, tone, noSummary } = recordingState(recording)
  return (
    <>
      <span className={`badge badge-${tone}`}>{label}</span>
      {noSummary && <span className="badge badge-warning">Sem resumo</span>}
    </>
  )
}
