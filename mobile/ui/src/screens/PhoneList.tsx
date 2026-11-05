import { duration, markers, when } from '../app/formats'
import type { Badge, LocalRecording } from '../bridge/types'
import { ESTADOS_APARELHO, type Tom } from '../app/vocabulario.js'

/** The phone's badges in the shared vocabulary (states on the device). */
const BADGES: Record<Badge, { rotulo: string; tom: Tom }> = {
  gravando: ESTADOS_APARELHO.recording,
  aguardando: ESTADOS_APARELHO.pending,
  sincronizando: ESTADOS_APARELHO.uploading,
  sincronizada: ESTADOS_APARELHO.uploaded,
  interrompida: ESTADOS_APARELHO.interrupted,
  falhou: ESTADOS_APARELHO.failed,
}

export function RecordingBadge({ badge }: { badge: Badge }) {
  const { rotulo, tom } = BADGES[badge]
  return <span className={tom === 'neutral' ? 'badge' : `badge badge-${tom}`}>{rotulo}</span>
}

/** A recording's row: "Hoje 09:00 · 54 min · 3 marcadores". */
function subtitle(recording: LocalRecording, now?: Date): string {
  const parts = [when(recording.iniciada_em, now), duration(recording.duracao_ms)]
  if (recording.marcadores > 0) parts.push(markers(recording.marcadores))
  return parts.join(' · ')
}

/** The phone list: the local recordings, with the sync badge. */
export function PhoneList({
  recordings,
  summary,
  open,
}: {
  recordings: LocalRecording[]
  summary: string
  open: (id: string) => void
}) {
  return (
    <div className="m-section m-fill m-scroll">
      <div className="row-between">
        <span className="kicker">Neste celular</span>
        <span className="text-muted text-12">
          {summary}
        </span>
      </div>
      {recordings.length === 0 ? (
        <p className="text-muted no-margin text-14">
          Nenhuma gravação ainda.
        </p>
      ) : (
        <ul className="m-rows">
          {recordings.map((recording) => (
            <li className="m-row" key={recording.id}>
              <button type="button" className="m-row-button" onClick={() => open(recording.id)}>
                <span className="m-row-title">{recording.titulo ?? recording.titulo_do_servidor ?? 'Sem título'}</span>
                <span className="m-row-sub">{subtitle(recording)}</span>
              </button>
              <span className="m-row-end">
                <RecordingBadge badge={recording.selo} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
