import { Link, useLocation } from 'react-router'
import type { Schemas } from '../../api/client'
import { dayKey, recordingTitle, sameDay, shortDuration } from './calendar'
import { shortDayLabel, timeLabel } from '../../shared/format'
import { StatusBadge } from './RecordingStatus'

type Recording = Schemas['Recording']

interface DayGroup {
  day: Date
  items: Recording[]
}

/** Agrupa por dia local, na ordem em que as gravações vieram. */
function groupByDay(recordings: Recording[]): DayGroup[] {
  const groups = new Map<string, DayGroup>()
  for (const recording of recordings) {
    const start = new Date(recording.recorded_at)
    const key = dayKey(start)
    const group = groups.get(key) ?? { day: start, items: [] }
    group.items.push(recording)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** A lista corrida: um `.day-group` por dia, com uma `.rec-row` por gravação. */
export function RecordingList({ recordings }: { recordings: Recording[] }) {
  const location = useLocation()
  const from = `${location.pathname}${location.search}`
  const today = new Date()
  return groupByDay(recordings).map(({ day, items }) => {
    const label = `${sameDay(day, today) ? 'Hoje · ' : ''}${shortDayLabel(day)}`
    return (
      <section key={dayKey(day)} className="day-group" aria-label={label}>
        <div className="day-group-head">
          <b>{label}</b>
          <span className="text-muted">{items.length === 1 ? '1 item' : `${items.length} itens`}</span>
        </div>
        {items.map((recording) => (
          <Link key={recording.id} to={`/gravacoes/${recording.id}`} state={{ from }} className="rec-row">
            <span className="mono">{timeLabel(new Date(recording.recorded_at))}</span>
            <span>
              <strong>{recordingTitle(recording)}</strong>{' '}
              {recording.kind !== 'note' && <span className="text-muted">· {shortDuration(recording.duration_ms)}</span>}
            </span>
            <span>
              <StatusBadge recording={recording} />
            </span>
          </Link>
        ))}
      </section>
    )
  })
}
