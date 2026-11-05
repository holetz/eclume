import { useTranslation } from 'react-i18next'
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

/** Groups by local day, in the order the recordings came. */
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

/** The running list: one `.day-group` per day, with one `.rec-row` per recording. */
export function RecordingList({ recordings }: { recordings: Recording[] }) {
  const { t } = useTranslation('library')
  const location = useLocation()
  const from = `${location.pathname}${location.search}`
  const today = new Date()
  return groupByDay(recordings).map(({ day, items }) => {
    const label = sameDay(day, today) ? t('list.today', { day: shortDayLabel(day) }) : shortDayLabel(day)
    return (
      <section key={dayKey(day)} className="day-group" aria-label={label}>
        <div className="day-group-head">
          <b>{label}</b>
          <span className="text-muted">{t('list.items', { count: items.length })}</span>
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
