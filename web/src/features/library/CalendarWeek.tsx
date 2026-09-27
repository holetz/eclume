import { useEffect, useState, type CSSProperties } from 'react'
import { Link, useLocation } from 'react-router'
import type { Schemas } from '../../api/client'
import {
  dayLabel,
  eventBox,
  eventLabel,
  hourRange,
  lanes,
  recordingTitle,
  sameDay,
  shortDuration,
  timeLabel,
  weekdayShort,
} from './calendar'
import { recordingState } from './format'
import styles from './LibraryPage.module.css'

type Recording = Schemas['Recording']

const HOUR_PX = 54

/** A hora de agora, relida a cada `intervalMs`. */
function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

interface CalendarWeekProps {
  days: Date[]
  recordings: Recording[]
  busy?: boolean
}

/** A semana como agenda: um bloco por gravação, na hora de início e com a altura da duração. */
export function CalendarWeek({ days, recordings, busy = false }: CalendarWeekProps) {
  const now = useNow(60_000)
  const location = useLocation()
  const from = `${location.pathname}${location.search}`
  const columns = days.map((day) =>
    lanes(
      recordings
        .filter((recording) => sameDay(new Date(recording.recorded_at), day))
        .map((recording) => ({ ...eventBox(recording), recording })),
    ),
  )
  const { start, end } = hourRange(columns.flat())
  const nowHour = now.getHours() + now.getMinutes() / 60
  const grid = { '--cal-start': start, '--cal-hour': `${HOUR_PX}px` } as CSSProperties

  return (
    <div className={styles.weekScroll}>
      <div className={`cal-week ${styles.week}`} style={grid} aria-busy={busy || undefined}>
        <span className="cal-head" aria-hidden="true" />
        {days.map((day) => (
          <span key={day.toISOString()} className="cal-head" aria-current={sameDay(day, now) ? 'date' : undefined}>
            {weekdayShort(day)}
            <b>{day.getDate()}</b>
          </span>
        ))}
        <div className="cal-hours" aria-hidden="true">
          {Array.from({ length: end - start }, (_, index) => (
            <span key={index}>{`${String(start + index).padStart(2, '0')}:00`}</span>
          ))}
        </div>
        {days.map((day, index) => (
          <div key={day.toISOString()} className="cal-col" role="list" aria-label={dayLabel(day)}>
            {sameDay(day, now) && nowHour >= start && nowHour <= end && (
              <div className="cal-now" style={{ '--s': nowHour } as CSSProperties} aria-hidden="true" />
            )}
            {columns[index].map(({ recording, s, d, lane, lanes: laneCount }) => {
              const state = recordingState(recording)
              const style = { '--s': s, '--d': d, '--lane': lane, '--lanes': laneCount } as CSSProperties
              return (
                <Link
                  key={recording.id}
                  to={`/gravacoes/${recording.id}`}
                  state={{ from }}
                  role="listitem"
                  className={`cal-event ${laneCount > 1 ? styles.laned : ''}`}
                  style={style}
                  data-kind={recording.kind === 'note' ? 'note' : undefined}
                  data-status={state.state === 'busy' ? 'processing' : state.state === 'failed' ? 'failed' : undefined}
                  aria-label={eventLabel(recording)}
                >
                  <strong>{recordingTitle(recording)}</strong>
                  {recording.kind !== 'note' && (
                    <span className="mono">
                      {state.state === 'ready'
                        ? `${timeLabel(new Date(recording.recorded_at))} · ${shortDuration(recording.duration_ms)}`
                        : state.label}
                    </span>
                  )}
                  {recording.marker_count > 0 && <span className={`marker-count ${styles.eventMarkers}`}>{recording.marker_count}</span>}
                </Link>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
