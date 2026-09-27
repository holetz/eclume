import { useEffect, useId, useRef, useState, type MouseEvent } from 'react'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { markersLabel } from '../library/calendar'
import { hms, placeMarkers, useMarkerMutations, type Marker } from './markers'
import { usePlayback } from './playback'
import { SegmentEditor } from './SegmentEditor'
import { findSegmentAt, speakerColorIndex, speakerName, type Segment, type Transcript } from './segments'
import { SpeakersPanel } from './SpeakersPanel'
import styles from './TranscriptView.module.css'

const MAX_NOTE = 500

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** A `.segment-marker` antes da fala: tempo, nota e dispositivo, com editar a nota e excluir. */
function SegmentMarker({ marker, recordingId }: { marker: Marker; recordingId: string }) {
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

function Segments({
  transcript,
  markers,
  recordingId,
}: {
  transcript: Transcript
  markers: Marker[]
  recordingId: string
}) {
  const { currentMs, seek } = usePlayback()
  const listRef = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const { segments, speakers } = transcript
  const active = findSegmentAt(segments, currentMs)
  const places = placeMarkers(segments, markers)
  const markersAt = (index: number) => markers.filter((_, position) => places[position] === index)

  useEffect(() => {
    if (!follow || active < 0) return
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [active, follow])

  function onSegmentClick(event: MouseEvent<HTMLDivElement>, segment: Segment) {
    // Botões e campos dentro da fala têm ação própria; a fala em edição não toca.
    if (editingId === segment.id || (event.target as HTMLElement).closest('button, textarea, input, a')) return
    seek(segment.start_ms, true)
  }

  return (
    <>
      <label className={`check ${styles.follow}`}>
        <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
        <span className="box" />
        <span>Acompanhar o áudio</span>
      </label>
      {segments.length === 0 ? (
        <p className="text-muted">A transcrição não tem falas.</p>
      ) : (
        <div ref={listRef} role="list" aria-label="Falas">
          {segments.map((segment, index) => {
            const speaker = speakers.find((item) => item.id === segment.speaker_id)
            const name = speakerName(speaker)
            const clock = hms(segment.start_ms)
            const color = speakerColorIndex(speakers, segment.speaker_id)
            return (
              <div key={segment.id} role="listitem" className={styles.item}>
                {markersAt(index).map((marker) => (
                  <SegmentMarker key={marker.id} marker={marker} recordingId={recordingId} />
                ))}
                <div
                  className={`segment ${styles.segment}`}
                  data-speaker={color}
                  aria-current={index === active ? 'true' : undefined}
                  onClick={(event) => onSegmentClick(event, segment)}
                >
                  <div className="segment-who">
                    <span className={`speaker speaker-${color}`}>{name}</span>
                    <button
                      type="button"
                      className={`timecode ${styles.timecode}`}
                      onClick={() => seek(segment.start_ms, true)}
                      aria-label={`Ouvir a partir de ${clock}, fala de ${name}`}
                    >
                      {clock}
                    </button>
                  </div>
                  <div className={styles.body}>
                    {editingId === segment.id ? (
                      <SegmentEditor
                        transcriptId={transcript.id}
                        segment={segment}
                        label={`Texto da fala de ${name} em ${clock}`}
                        onClose={() => setEditingId(null)}
                      />
                    ) : (
                      <>
                        <p className="segment-text">{segment.text}</p>
                        <button
                          type="button"
                          className={`btn btn-ghost btn-sm ${styles.edit}`}
                          onClick={() => setEditingId(segment.id)}
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
          })}
        </div>
      )}
      {markersAt(segments.length).map((marker) => (
        <SegmentMarker key={marker.id} marker={marker} recordingId={recordingId} />
      ))}
    </>
  )
}

interface TranscriptDisclosureProps {
  transcript: Transcript
  markers: Marker[]
  recordingId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * A transcrição recolhida (`details.disclosure`): o resumo diz locutores, falas e marcadores; aberta,
 * traz o bloco Locutores e as falas com os marcadores. As falas só renderizam com ela aberta.
 */
export function TranscriptDisclosure({
  transcript,
  markers,
  recordingId,
  open,
  onOpenChange,
}: TranscriptDisclosureProps) {
  return (
    <details
      className={`disclosure ${styles.disclosure}`}
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) onOpenChange(event.currentTarget.open)
      }}
    >
      <summary>
        Transcrição
        <span className="text-muted">
          {plural(transcript.speakers.length, 'locutor', 'locutores')} ·{' '}
          {plural(transcript.segments.length, 'fala', 'falas')}
          {markers.length > 0 && (
            <>
              {' '}
              · <span className="marker-count">{markersLabel(markers.length)}</span>
            </>
          )}{' '}
          · abra para conferir ou corrigir
        </span>
      </summary>
      {open && (
        <div className={styles.view}>
          <SpeakersPanel transcript={transcript} />
          <Segments transcript={transcript} markers={markers} recordingId={recordingId} />
        </div>
      )}
    </details>
  )
}
