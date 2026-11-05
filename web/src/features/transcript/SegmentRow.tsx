import { memo, useId, useState, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { hms, useMarkerMutations, type Marker } from './markers'
import { SegmentEditor } from './SegmentEditor'
import type { Segment } from './segments'
import styles from './TranscriptView.module.css'

const MAX_NOTE = 500

/** The `.segment-marker` before the segment: time, note and device, with edit note and delete. */
export function SegmentMarker({ marker, recordingId }: { marker: Marker; recordingId: string }) {
  const { t } = useTranslation(['transcript', 'common'])
  const { editNote, remove } = useMarkerMutations(recordingId)
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState(marker.note ?? '')
  const [confirming, setConfirming] = useState(false)
  const inputId = useId()
  const at = hms(marker.at_ms)

  function save() {
    const value = note.trim()
    editNote.mutate({ id: marker.id, note: value || null }, { onSuccess: () => setEditing(false) })
  }

  return (
    <div className="segment-marker" aria-label={t('marker.group', { time: at })} role="group">
      <span className="marker-count">{at}</span>
      <span className="segment-marker-note">
        {editing ? (
          <>
            <label htmlFor={inputId} className="visually-hidden">
              {t('marker.noteLabel', { time: at })}
            </label>
            <input
              id={inputId}
              className={`input ${styles.noteInput}`}
              value={note}
              maxLength={MAX_NOTE}
              autoFocus
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') save()
                if (event.key === 'Escape') setEditing(false)
              }}
            />
            <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={editNote.isPending}>
              {t('common:save')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
              {t('common:cancel')}
            </button>
          </>
        ) : (
          <>
            <b>{marker.note ?? t('markers.marker')}</b>
            {marker.device_name && <span>{t('markers.device', { device: marker.device_name })}</span>}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setNote(marker.note ?? '')
                setEditing(true)
              }}
            >
              {t('marker.editNote')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>
              {t('marker.delete')}
            </button>
          </>
        )}
        {editNote.isError && (
          <span className="alert alert-error" role="alert">
            {errorMessage(editNote.error)}
          </span>
        )}
      </span>
      {confirming && (
        <ConfirmDialog
          title={t('marker.deleteTitle')}
          confirmLabel={t('marker.delete')}
          busy={remove.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => remove.mutate(marker.id, { onSuccess: () => setConfirming(false) })}
        >
          <p>
            {marker.note
              ? t('marker.deleteTextNote', { time: at, note: marker.note })
              : t('marker.deleteText', { time: at })}
          </p>
        </ConfirmDialog>
      )}
    </div>
  )
}

interface SegmentRowProps {
  segment: Segment
  name: string
  color: number
  /** The markers before this segment (the same array across renders, for `memo`). */
  markers: Marker[]
  active: boolean
  editing: boolean
  transcriptId: string
  recordingId: string
  onSeek: (ms: number, play?: boolean) => void
  onEdit: (segmentId: string | null) => void
}

/**
 * A segment in the DS `.segment`, with the markers before it. Memoized with stable props: an audio
 * tick does not render it, and changing the active segment renders only the outgoing and the incoming one.
 */
export const SegmentRow = memo(function SegmentRow({
  segment,
  name,
  color,
  markers,
  active,
  editing,
  transcriptId,
  recordingId,
  onSeek,
  onEdit,
}: SegmentRowProps) {
  const { t } = useTranslation('transcript')
  const clock = hms(segment.start_ms)

  function onSegmentClick(event: MouseEvent<HTMLDivElement>) {
    // Buttons and fields inside the segment have their own action; the segment being edited does not play.
    if (editing || (event.target as HTMLElement).closest('button, textarea, input, a')) return
    onSeek(segment.start_ms, true)
  }

  return (
    <div role="listitem" className={styles.item}>
      {markers.map((marker) => (
        <SegmentMarker key={marker.id} marker={marker} recordingId={recordingId} />
      ))}
      <div
        className={`segment ${styles.segment}`}
        data-speaker={color}
        aria-current={active ? 'true' : undefined}
        onClick={onSegmentClick}
      >
        <div className="segment-who">
          <span className={`speaker speaker-${color}`}>{name}</span>
          <button
            type="button"
            className={`timecode ${styles.timecode}`}
            onClick={() => onSeek(segment.start_ms, true)}
            aria-label={t('segment.listen', { time: clock, name })}
          >
            {clock}
          </button>
        </div>
        <div className={styles.body}>
          {editing ? (
            <SegmentEditor
              transcriptId={transcriptId}
              segment={segment}
              label={t('segment.textLabel', { name, time: clock })}
              onClose={() => onEdit(null)}
            />
          ) : (
            <>
              <p className="segment-text">{segment.text}</p>
              <button
                type="button"
                className={`btn btn-ghost btn-sm ${styles.edit}`}
                onClick={() => onEdit(segment.id)}
                aria-label={t('segment.fixLabel', { name, time: clock })}
              >
                {t('segment.fix')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
})
