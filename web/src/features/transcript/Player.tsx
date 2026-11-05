import { Pause, Play } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { currentMarkerId, hms, type Marker } from './markers'
import { rateLabel, usePlayback, usePlaybackTime } from './playback'
import styles from './RecordingPage.module.css'

/**
 * The DS compact player: play/pause, the time, the track (drag or keyboard through the `range`) with one
 * tick per marker, the duration and the speed.
 */
export function Player({ markers }: { markers: Marker[] }) {
  const { t } = useTranslation(['transcript', 'common'])
  const { durationMs, playing, rate, seek, toggle, cycleRate, error, retry } = usePlayback()
  const currentMs = usePlaybackTime()
  const current = currentMarkerId(markers, currentMs)
  const percent = (ms: number) => (durationMs > 0 ? Math.min(100, (ms / durationMs) * 100) : 0)

  return (
    <>
      <div className="player" role="group" aria-label={t('player.label')}>
        <button
          type="button"
          className="btn btn-primary btn-icon"
          aria-label={playing ? t('player.pause') : t('player.play')}
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
            aria-label={t('player.position')}
            aria-valuetext={hms(currentMs)}
            onChange={(event) => seek(Number(event.target.value))}
          />
          {markers.map((marker) => (
            <button
              key={marker.id}
              type="button"
              className="player-tick"
              style={{ '--at': `${percent(marker.at_ms)}%` } as CSSProperties}
              aria-label={
                marker.note
                  ? t('player.markerNote', { time: hms(marker.at_ms), note: marker.note })
                  : t('player.marker', { time: hms(marker.at_ms) })
              }
              aria-current={marker.id === current ? 'true' : undefined}
              onClick={() => seek(marker.at_ms, true)}
            />
          ))}
        </div>
        <span className="text-muted">{hms(durationMs)}</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label={t('player.speed', { rate: rateLabel(rate) })}
          onClick={cycleRate}
        >
          {rateLabel(rate)}
        </button>
      </div>
      {error === 'network' && (
        <p className="alert alert-error" role="alert">
          <span>{t('player.loadFailed')}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>
            {t('common:retry')}
          </button>
        </p>
      )}
      {error === 'format' && (
        <p className="alert alert-warning" role="alert">
          {t('player.format')}
        </p>
      )}
    </>
  )
}
