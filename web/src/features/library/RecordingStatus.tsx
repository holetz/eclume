import type { Schemas } from '../../api/client'
import { recordingState } from '../../shared/format'

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
