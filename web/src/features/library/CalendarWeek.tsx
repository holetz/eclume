import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Link, useLocation } from 'react-router'
import { ZoomIn, ZoomOut } from 'lucide-react'
import type { Schemas } from '../../api/client'
import { dayLabel, eventBox, eventLabel, lanes, recordingTitle, sameDay, shortDuration } from './calendar'
import { readWorkHours } from '../../app/preferences'

import styles from './LibraryPage.module.css'
import { recordingState, timeLabel, weekdayShort } from '../../shared/format'

type Recording = Schemas['Recording']

/** A altura da hora quando a janela não dá medida (o jsdom, por exemplo). */
const HOUR_PX = 54
/** O zoom máximo: uma hora com altura para ler reuniões de poucos minutos. */
const MAX_HOUR_PX = 480
const ZOOM_STEP = 1.25
/** O respiro de baixo da página (.content), que a semana não ocupa. */
const BOTTOM_PX = 32
/** A semana nunca fica mais baixa que isto, mesmo numa janela curta. */
const MIN_HEIGHT_PX = 320
const HOURS = 24

/** A hora de agora, relida a cada `intervalMs`. */
function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

/** A altura do contêiner da semana: da posição dele até o fim da janela, relida no resize. */
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
 * A semana como agenda: o dia inteiro (0–24) numa grade que rola por dentro e ocupa a altura da
 * tela, com o expediente (8–18, ou o da tela Ambiente) destacado e enquadrado ao abrir. O resto do dia fica a um pan ou a um
 * zoom out: o zoom muda a altura da hora, pelos botões do canto ou por Ctrl + roda sobre a grade, e o
 * mínimo é o dia inteiro na tela.
 */
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

  // Abre cada semana (e a primeira medida) no começo do expediente, logo abaixo do cabeçalho.
  const weekKey = days[0]?.toISOString()
  const openedFor = useRef<string | null>(null)
  useLayoutEffect(() => {
    const box = scrollRef.current
    if (!box || !measured || openedFor.current === weekKey) return
    openedFor.current = weekKey ?? null
    box.scrollTop = focus.start * hourPx
  }, [scrollRef, measured, weekKey, focus.start, hourPx])

  // O zoom mantém parada a hora sob o cursor (ou no meio da tela, pelos botões).
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
      style={measured ? { height } : undefined}
      title="Ctrl + roda do mouse muda o zoom"
    >
      <div className={`cal-week ${styles.week}`} style={grid} aria-busy={busy || undefined}>
        <span className={`cal-head ${styles.zoom}`}>
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            aria-label="Diminuir o zoom"
            disabled={!canZoomOut}
            onClick={() => zoomTo(hourPx / ZOOM_STEP)}
          >
            <ZoomOut size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            aria-label="Aumentar o zoom"
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
