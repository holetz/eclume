import { memo, useId, useState, type MouseEvent } from 'react'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { hms, useMarkerMutations, type Marker } from './markers'
import { SegmentEditor } from './SegmentEditor'
import type { Segment } from './segments'
import styles from './TranscriptView.module.css'

const MAX_NOTE = 500

/** A `.segment-marker` antes da fala: tempo, nota e dispositivo, com editar a nota e excluir. */
export function SegmentMarker({ marker, recordingId }: { marker: Marker; recordingId: string }) {
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
    <div className="segment-marker" aria-label={`Marcador em ${at}`} role="group">
      <span className="marker-count">{at}</span>
      <span className="segment-marker-note">
        {editing ? (
          <>
            <label htmlFor={inputId} className="visually-hidden">
              Nota do marcador em {at}
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
              Salvar
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
              Cancelar
            </button>
          </>
        ) : (
          <>
            <b>{marker.note ?? 'Marcador'}</b>
            {marker.device_name && <span>Marcado no {marker.device_name}</span>}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setNote(marker.note ?? '')
                setEditing(true)
              }}
            >
              Editar nota
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>
              Excluir marcador
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
          title="Excluir o marcador?"
          confirmLabel="Excluir marcador"
          busy={remove.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => remove.mutate(marker.id, { onSuccess: () => setConfirming(false) })}
        >
          <p>
            O marcador em {at}
            {marker.note ? ` ("${marker.note}")` : ''} sai da gravação.
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
  /** Os marcadores antes desta fala (o mesmo array entre renders, para o `memo`). */
  markers: Marker[]
  active: boolean
  editing: boolean
  transcriptId: string
  recordingId: string
  onSeek: (ms: number, play?: boolean) => void
  onEdit: (segmentId: string | null) => void
}

/**
 * Uma fala no `.segment` do DS, com os marcadores antes dela. Memoizada com props estáveis: um tick
 * do áudio não a renderiza, e a troca de fala ativa renderiza só a que sai e a que entra.
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
  const clock = hms(segment.start_ms)

  function onSegmentClick(event: MouseEvent<HTMLDivElement>) {
    // Botões e campos dentro da fala têm ação própria; a fala em edição não toca.
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
            aria-label={`Ouvir a partir de ${clock}, fala de ${name}`}
          >
            {clock}
          </button>
        </div>
        <div className={styles.body}>
          {editing ? (
            <SegmentEditor
              transcriptId={transcriptId}
              segment={segment}
              label={`Texto da fala de ${name} em ${clock}`}
              onClose={() => onEdit(null)}
            />
          ) : (
            <>
              <p className="segment-text">{segment.text}</p>
              <button
                type="button"
                className={`btn btn-ghost btn-sm ${styles.edit}`}
                onClick={() => onEdit(segment.id)}
                aria-label={`Corrigir a fala de ${name} em ${clock}`}
              >
                Corrigir
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
})
