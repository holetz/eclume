import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'
import { ZoomIn, ZoomOut } from 'lucide-react'
import type { Schemas } from '../../api/client'
import { dayLabel, eventBox, eventLabel, lanes, recordingTitle, sameDay, shortDuration } from './calendar'
import { readWorkHours } from '../../app/preferences'

import styles from './LibraryPage.module.css'
import { recordingState, timeLabel, weekdayShort } from '../../shared/format'

type Recording = Schemas['Recording']

/** The hour height when the window gives no measure (jsdom, for example). */
const HOUR_PX = 54
/** The maximum zoom: an hour tall enough to read meetings of a few minutes. */
const MAX_HOUR_PX = 480
const ZOOM_STEP = 1.25
/** The bottom spacing of the page (.content), which the week does not take. */
const BOTTOM_PX = 32
/** The week is never shorter than this, even in a short window. */
const MIN_HEIGHT_PX = 320
const HOURS = 24

/** The current time, re-read every `intervalMs`. */
function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

/** The height of the week container: from its position to the end of the window, re-read on resize. */
function useViewportHeight() {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    const measure = () => {
      const box = ref.current
      if (!box) return
      const top = box.getBoundingClientRect().top + window.scrollY
      setHeight(Math.max(MIN_HEIGHT_PX, Math.floor(window.innerHeight - top - BOTTOM_PX)))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  return { ref, height }
}

interface CalendarWeekProps {
  days: Date[]
  recordings: Recording[]
  busy?: boolean
}

/**
 * The week as an agenda: the whole day (0–24) in a grid that scrolls inside and takes the height of the
 * screen, with the working hours (8–18, or those of the Environment screen) highlighted and framed on open. The rest of the day is a pan or a
 * zoom out away: zoom changes the hour height, through the corner buttons or Ctrl + wheel over the grid, and the
 * minimum is the whole day on screen.
 */
export function CalendarWeek({ days, recordings, busy = false }: CalendarWeekProps) {
  const { t } = useTranslation('library')
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
  const [work] = useState(readWorkHours)
  const focus = work
  const nowHour = now.getHours() + now.getMinutes() / 60

  const { ref: scrollRef, height } = useViewportHeight()
  const [headPx, setHeadPx] = useState(0)
  const [zoom, setZoom] = useState<number | null>(null)
  const body = height - headPx
  const measured = body > 0
  const minHourPx = measured ? body / HOURS : HOUR_PX
  const clamp = useCallback((value: number) => Math.min(MAX_HOUR_PX, Math.max(minHourPx, value)), [minHourPx])
  const hourPx = measured ? clamp(zoom ?? body / (focus.end - focus.start)) : HOUR_PX

  useLayoutEffect(() => {
    setHeadPx(scrollRef.current?.querySelector<HTMLElement>('.cal-head')?.offsetHeight ?? 0)
  }, [scrollRef, height])

  // Opens each week (and the first measure) at the start of working hours, just below the header.
  const weekKey = days[0]?.toISOString()
  const openedFor = useRef<string | null>(null)
  useLayoutEffect(() => {
    const box = scrollRef.current
    if (!box || !measured || openedFor.current === weekKey) return
    openedFor.current = weekKey ?? null
    box.scrollTop = focus.start * hourPx
  }, [scrollRef, measured, weekKey, focus.start, hourPx])

  // Zoom keeps still the hour under the cursor (or at the middle of the screen, through the buttons).
  const anchor = useRef<{ hour: number; offset: number } | null>(null)
  const hourPxRef = useRef(hourPx)
  useLayoutEffect(() => {
    hourPxRef.current = hourPx
  }, [hourPx])
  const zoomTo = useCallback(
    (next: number, clientY?: number) => {
      const box = scrollRef.current
      if (!box) return
      const rect = box.getBoundingClientRect()
      const offset = (clientY ?? rect.top + (box.clientHeight + headPx) / 2) - rect.top
      anchor.current = { hour: (box.scrollTop + offset - headPx) / hourPxRef.current, offset }
      setZoom(clamp(next))
    },
    [scrollRef, headPx, clamp],
  )
  useLayoutEffect(() => {
    const box = scrollRef.current
    if (!box || !anchor.current) return
    box.scrollTop = headPx + anchor.current.hour * hourPx - anchor.current.offset
    anchor.current = null
  }, [scrollRef, headPx, hourPx])

  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      zoomTo(hourPxRef.current * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), event.clientY)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [scrollRef, zoomTo])

  const grid = {
    '--cal-start': 0,
    '--cal-hour': `${hourPx}px`,
    '--work-start': work.start,
    '--work-end': work.end,
  } as CSSProperties
  const canZoomOut = measured && hourPx > minHourPx + 0.5
  const canZoomIn = hourPx < MAX_HOUR_PX

  return (
    <div
      ref={scrollRef}
      className={styles.weekScroll}
      style={measured ? ({ '--altura-visivel': `${height}px` } as CSSProperties) : undefined}
      title={t('calendar.zoomHint')}
    >
      <div className={`cal-week ${styles.week}`} style={grid} aria-busy={busy || undefined}>
        <span className={`cal-head ${styles.zoom}`}>
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            aria-label={t('calendar.zoomOut')}
            disabled={!canZoomOut}
            onClick={() => zoomTo(hourPx / ZOOM_STEP)}
          >
            <ZoomOut size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            aria-label={t('calendar.zoomIn')}
            disabled={!canZoomIn}
            onClick={() => zoomTo(hourPx * ZOOM_STEP)}
          >
            <ZoomIn size={14} aria-hidden="true" />
          </button>
        </span>
        {days.map((day) => (
          <span key={day.toISOString()} className="cal-head" aria-current={sameDay(day, now) ? 'date' : undefined}>
            {weekdayShort(day)}
            <b>{day.getDate()}</b>
          </span>
        ))}
        <div className={`cal-hours ${styles.hours}`} aria-hidden="true">
          {Array.from({ length: HOURS }, (_, hour) => (
            <span key={hour} data-work={(hour >= work.start && hour <= work.end) || undefined}>
              {`${String(hour).padStart(2, '0')}:00`}
            </span>
          ))}
          <span className={styles.hourEnd}>24:00</span>
        </div>
        {days.map((day, index) => (
          <div key={day.toISOString()} className="cal-col" role="list" aria-label={dayLabel(day)}>
            {sameDay(day, now) && (
              <div className="cal-now" style={{ '--s': nowHour } as CSSProperties} aria-hidden="true" />
            )}
            {columns[index].map(({ recording, s, d, lane, lanes: laneCount }) => {
              const state = recordingState(recording)
              const style = { '--s': s, '--d': d, '--lane': lane, '--lanes': laneCount } as CSSProperties
              return (
                // The list item carries the position and the status; the link fills the box and carries the name.
                <div
                  key={recording.id}
                  role="listitem"
                  className={`cal-event ${styles.event} ${laneCount > 1 ? styles.laned : ''}`}
                  style={style}
                  data-kind={recording.kind === 'note' ? 'note' : undefined}
                  data-status={state.state === 'busy' ? 'processing' : state.state === 'failed' ? 'failed' : undefined}
                >
                  <Link
                    to={`/gravacoes/${recording.id}`}
                    state={{ from }}
                    className={styles.eventLink}
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
                    {recording.marker_count > 0 && (
                      <span className={`marker-count ${styles.eventMarkers}`}>{recording.marker_count}</span>
                    )}
                  </Link>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
