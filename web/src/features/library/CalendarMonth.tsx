import { Link, useLocation } from 'react-router'
import type { Schemas } from '../../api/client'
import { dayLabel, recordingTitle, sameDay, weekdayShort, type MonthCell } from './calendar'
import styles from './LibraryPage.module.css'

type Recording = Schemas['Recording']

const MAX_DOTS = 3

interface CalendarMonthProps {
  cells: MonthCell[]
  recordings: Recording[]
  onOpenWeek: (day: Date) => void
  busy?: boolean
}

/** O mês em grade: até três gravações por dia, e o número do dia abre a semana dele. */
export function CalendarMonth({ cells, recordings, onOpenWeek, busy = false }: CalendarMonthProps) {
  const location = useLocation()
  const from = `${location.pathname}${location.search}`
  const today = new Date()
  return (
    <div className="cal-month" aria-busy={busy || undefined}>
      {cells.slice(0, 7).map((cell) => (
        <span key={cell.date.toISOString()} className="cal-dow">
          {weekdayShort(cell.date)}
        </span>
      ))}
      {cells.map((cell) => {
        const items = recordings.filter((recording) => sameDay(new Date(recording.recorded_at), cell.date))
        return (
          <div
            key={cell.date.toISOString()}
            className="cal-cell"
            role="group"
            aria-label={dayLabel(cell.date)}
            data-outside={cell.outside || undefined}
            aria-current={sameDay(cell.date, today) ? 'date' : undefined}
          >
            <b>
              <button
                type="button"
                className={styles.dayButton}
                aria-label={`Abrir a semana de ${dayLabel(cell.date)}`}
                onClick={() => onOpenWeek(cell.date)}
              >
                {cell.date.getDate()}
              </button>
            </b>
            {items.slice(0, MAX_DOTS).map((recording) => (
              <Link
                key={recording.id}
                to={`/gravacoes/${recording.id}`}
                state={{ from }}
                className={`cal-dot ${styles.dot}`}
              >
                {recordingTitle(recording)}
              </Link>
            ))}
            {items.length > MAX_DOTS && <span className="text-muted">+{items.length - MAX_DOTS}</span>}
          </div>
        )
      })}
    </div>
  )
}
