import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { usePlayback } from './playback'
import { SegmentEditor } from './SegmentEditor'
import { findSegmentAt, formatClock, speakerColorIndex, speakerName, type Segment, type Transcript } from './segments'
import styles from './TranscriptView.module.css'

interface TranscriptViewProps {
  transcript: Transcript
}

export function TranscriptView({ transcript }: TranscriptViewProps) {
  const { currentMs, seek } = usePlayback()
  const listRef = useRef<HTMLOListElement>(null)
  const [follow, setFollow] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const { segments, speakers } = transcript
  const active = findSegmentAt(segments, currentMs)
  const withHours = transcript.duration_ms >= 3_600_000

  useEffect(() => {
    if (!follow || active < 0) return
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [active, follow])

  function onSegmentClick(event: MouseEvent<HTMLLIElement>, segment: Segment) {
    // Botões e campos dentro do segmento têm ação própria; a fala em edição não toca.
    if (editingId === segment.id || (event.target as HTMLElement).closest('button, textarea, input, a')) return
    seek(segment.start_ms, true)
  }

  return (
    <div className={styles.view}>
      <label className={styles.follow}>
        <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
        Acompanhar o áudio
      </label>

      {segments.length === 0 ? (
        <p className="text-muted">A transcrição não tem falas.</p>
      ) : (
        <ol ref={listRef} className={styles.segments} aria-label="Falas">
          {segments.map((segment, index) => {
            const speaker = speakers.find((s) => s.id === segment.speaker_id)
            const name = speakerName(speaker)
            const clock = formatClock(segment.start_ms, withHours)
            return (
              <li
                key={segment.id}
                className={styles.segment}
                aria-current={index === active ? 'true' : undefined}
                data-speaker={speakerColorIndex(speakers, segment.speaker_id)}
                onClick={(event) => onSegmentClick(event, segment)}
              >
                <div className={styles.segmentHead}>
                  <span className={styles.speaker}>{name}</span>
                  <button
                    type="button"
                    className={styles.time}
                    onClick={() => seek(segment.start_ms, true)}
                    aria-label={`Ouvir a partir de ${clock}, fala de ${name}`}
                  >
                    {clock}
                  </button>
                  {editingId !== segment.id && (
                    <button
                      type="button"
                      className={`btn btn-ghost btn-sm ${styles.edit}`}
                      onClick={() => setEditingId(segment.id)}
                      aria-label={`Corrigir a fala de ${name} em ${clock}`}
                    >
                      Corrigir
                    </button>
                  )}
                </div>
                {editingId === segment.id ? (
                  <SegmentEditor
                    transcriptId={transcript.id}
                    segment={segment}
                    label={`Texto da fala de ${name} em ${clock}`}
                    onClose={() => setEditingId(null)}
                  />
                ) : (
                  <p className={styles.text}>{segment.text}</p>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
