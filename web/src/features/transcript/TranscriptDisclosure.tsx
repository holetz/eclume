import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { placeMarkers, type Marker } from './markers'
import { usePlayback, usePlaybackSelect } from './playback'
import { scrollWithin } from './scroll'
import { SegmentMarker, SegmentRow } from './SegmentRow'
import { findSegmentAt, speakerColorIndex, speakerName, type Transcript } from './segments'
import styles from './TranscriptView.module.css'
import { markersLabel } from '../../shared/format'

const NO_MARKERS: Marker[] = []

function Segments({
  transcript,
  markers,
  recordingId,
  anchorMs,
}: {
  transcript: Transcript
  markers: Marker[]
  recordingId: string
  anchorMs: number | null
}) {
  const { t } = useTranslation('transcript')
  const { seek } = usePlayback()
  const listRef = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const { segments, speakers } = transcript
  // Only changing the active segment renders the list; a tick that does not change it never reaches here.
  const active = usePlaybackSelect((ms) => findSegmentAt(segments, ms))
  // The speaker's name and color and each segment's markers, computed once per transcript.
  const who = useMemo(
    () =>
      segments.map((segment) => ({
        name: speakerName(speakers.find((item) => item.id === segment.speaker_id)),
        color: speakerColorIndex(speakers, segment.speaker_id),
      })),
    [segments, speakers],
  )
  const markersAt = useMemo(() => {
    const byIndex = new Map<number, Marker[]>()
    placeMarkers(segments, markers).forEach((index, position) => {
      byIndex.set(index, [...(byIndex.get(index) ?? []), markers[position]])
    })
    return byIndex
  }, [segments, markers])

  const anchored = useRef(false)

  // Opened by the URL with `?t=` (search, chat source, marker): once, brings the list into the window and
  // centers the instant's segment in it.
  useEffect(() => {
    const list = listRef.current
    if (anchored.current || anchorMs === null || !list) return
    anchored.current = true
    const index = findSegmentAt(segments, anchorMs)
    if (index < 0) return
    list.scrollIntoView({ block: 'nearest' })
    scrollWithin(list, list.children[index], 'center')
  }, [anchorMs, segments])

  // Following the audio scrolls only the list, which is the container with its own scroll: `scrollIntoView` on the
  // segment would also scroll the page and take the player off screen.
  useEffect(() => {
    const list = listRef.current
    if (!follow || active < 0 || !list?.children[active]) return
    scrollWithin(list, list.children[active], 'nearest', 'smooth')
  }, [active, follow])

  return (
    <>
      <label className={`check ${styles.follow}`}>
        <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
        <span className="box" />
        <span>{t('disclosure.follow')}</span>
      </label>
      {segments.length === 0 ? (
        <p className="text-muted">{t('disclosure.empty')}</p>
      ) : (
        <div ref={listRef} role="list" aria-label={t('disclosure.list')} className={styles.scroller}>
          {segments.map((segment, index) => (
            <SegmentRow
              key={segment.id}
              segment={segment}
              name={who[index].name}
              color={who[index].color}
              markers={markersAt.get(index) ?? NO_MARKERS}
              active={index === active}
              editing={editingId === segment.id}
              transcriptId={transcript.id}
              recordingId={recordingId}
              onSeek={seek}
              onEdit={setEditingId}
            />
          ))}
        </div>
      )}
      {(markersAt.get(segments.length) ?? NO_MARKERS).map((marker) => (
        <SegmentMarker key={marker.id} marker={marker} recordingId={recordingId} />
      ))}
    </>
  )
}

interface TranscriptDisclosureProps {
  transcript: Transcript
  markers: Marker[]
  recordingId: string
  /** The instant of the URL's `?t=`, for the one-time scroll to its segment. */
  anchorMs?: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The collapsed transcript (`details.disclosure`): the summary states speakers, segments and markers; open,
 * it brings the segments with the markers, in an area with its own scroll. The speakers stay in their own block
 * (`SpeakersDisclosure`). The segments only render while it is open.
 */
export function TranscriptDisclosure({
  transcript,
  markers,
  recordingId,
  anchorMs = null,
  open,
  onOpenChange,
}: TranscriptDisclosureProps) {
  const { t } = useTranslation('transcript')
  return (
    <details
      className={`disclosure ${styles.disclosure}`}
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) onOpenChange(event.currentTarget.open)
      }}
    >
      <summary>
        {t('disclosure.title')}
        <span className="text-muted">
          {t('disclosure.speakers', { count: transcript.speakers.length })} ·{' '}
          {t('disclosure.segments', { count: transcript.segments.length })}
          {markers.length > 0 && (
            <>
              {' '}
              · <span className="marker-count">{markersLabel(markers.length)}</span>
            </>
          )}{' '}
          · {t('disclosure.openHint')}
        </span>
      </summary>
      {open && (
        <div className={styles.view}>
          <Segments transcript={transcript} markers={markers} recordingId={recordingId} anchorMs={anchorMs} />
        </div>
      )}
    </details>
  )
}
