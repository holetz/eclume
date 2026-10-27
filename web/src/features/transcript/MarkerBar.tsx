import { commonDevice, hms, type Marker } from './markers'
import { usePlayback } from './playback'
import styles from './RecordingPage.module.css'

/** The `.marker-bar`: one chip per marker, which plays from there, and the device when there is only one. */
export function MarkerBar({ markers }: { markers: Marker[] }) {
  const { seek } = usePlayback()
  if (markers.length === 0) return null
  const device = commonDevice(markers)
  return (
    <div className="marker-bar" role="group" aria-label="Marcadores">
      <span className="kicker">Marcadores</span>
      {markers.map((marker) => (
        <button
          key={marker.id}
          type="button"
          className="marker-chip"
          data-empty={marker.note ? undefined : ''}
          onClick={() => seek(marker.at_ms, true)}
        >
          <span className="mono">{hms(marker.at_ms)}</span>
          <span>{marker.note ?? 'Marcador'}</span>
        </button>
      ))}
      {device && <span className={`text-muted ${styles.markerDevice}`}>Marcado no {device}</span>}
    </div>
  )
}
