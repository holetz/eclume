import { useT } from '../i18n'
import { duration, markers, when } from '../app/formats'
import type { Badge, LocalRecording } from '../bridge/types'
import { deviceStateLabel, deviceStateTone, type DeviceState } from '../i18n/vocabulary'

/** Map serialized badges to the shared device vocabulary. */
const BADGES: Record<Badge, DeviceState> = {
  gravando: 'recording',
  aguardando: 'pending',
  sincronizando: 'uploading',
  sincronizada: 'uploaded',
  interrompida: 'interrupted',
  falhou: 'failed',
}

export function RecordingBadge({ badge }: { badge: Badge }) {
  useT()
  const state = BADGES[badge]
  const tone = deviceStateTone(state)
  return <span className={tone === 'neutral' ? 'badge' : `badge badge-${tone}`}>{deviceStateLabel(state)}</span>
}

/** A recording's row: "Today 09:00 · 54 min · 3 markers". */
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
  const t = useT()
  return (
    <div className="m-section m-fill m-scroll">
      <div className="row-between">
        <span className="kicker">{t('phoneList.heading')}</span>
        <span className="text-muted text-12">
          {summary}
        </span>
      </div>
      {recordings.length === 0 ? (
        <p className="text-muted no-margin text-14">
          {t('phoneList.empty')}
        </p>
      ) : (
        <ul className="m-rows">
          {recordings.map((recording) => (
            <li className="m-row" key={recording.id}>
              <button type="button" className="m-row-button" onClick={() => open(recording.id)}>
                <span className="m-row-title">{recording.titulo ?? recording.titulo_do_servidor ?? t('phoneList.untitled')}</span>
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
