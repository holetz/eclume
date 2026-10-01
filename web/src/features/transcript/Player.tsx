import { Pause, Play } from 'lucide-react'
import type { CSSProperties } from 'react'
import { currentMarkerId, hms, type Marker } from './markers'
import { rateLabel, usePlayback } from './playback'
import styles from './RecordingPage.module.css'

/**
 * O player compacto do DS: tocar/pausar, o tempo, a trilha (arrastar ou teclado pelo `range`) com um
 * tick por marcador, a duração e a velocidade.
 */
export function Player({ markers }: { markers: Marker[] }) {
  const { currentMs, durationMs, playing, rate, seek, toggle, cycleRate, error, retry } = usePlayback()
  const current = currentMarkerId(markers, currentMs)
  const percent = (ms: number) => (durationMs > 0 ? Math.min(100, (ms / durationMs) * 100) : 0)

  return (
    <div className="player" role="group" aria-label="Player">
      <button
        type="button"
        className="btn btn-primary btn-icon"
        aria-label={playing ? 'Pausar' : 'Tocar'}
        onClick={toggle}
        disabled={error !== null}
      >
        {playing ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
      </button>
      <span>{hms(currentMs)}</span>
      <div className="player-track">
        <progress className="progress" max={100} value={percent(currentMs)} aria-hidden="true" />
        <input
          type="range"
          className={styles.seek}
          min={0}
          max={Math.max(durationMs, 1)}
          step={1000}
          value={Math.min(currentMs, durationMs)}
          aria-label="Posição no áudio"
          aria-valuetext={hms(currentMs)}
          onChange={(event) => seek(Number(event.target.value))}
        />
        {markers.map((marker) => (
          <button
            key={marker.id}
            type="button"
            className="player-tick"
            style={{ '--at': `${percent(marker.at_ms)}%` } as CSSProperties}
            aria-label={`Marcador em ${hms(marker.at_ms)}${marker.note ? `: ${marker.note}` : ''}`}
            aria-current={marker.id === current ? 'true' : undefined}
            onClick={() => seek(marker.at_ms, true)}
          />
        ))}
      </div>
      <span className="text-muted">{hms(durationMs)}</span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-label={`Velocidade ${rateLabel(rate)}`}
        onClick={cycleRate}
      >
        {rateLabel(rate)}
      </button>
      {error === 'network' && (
        <p className="alert alert-error" role="alert">
          <span>O áudio não carregou.</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>
            Tentar de novo
          </button>
        </p>
      )}
      {error === 'format' && (
        <p className="alert alert-warning" role="alert">
          Este navegador não toca o áudio do eclume (Ogg Opus). Abra a gravação no Chrome, no Edge ou no Firefox.
        </p>
      )}
    </div>
  )
}
