import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { findSegmentAt, formatClock, speakerColorIndex, speakerName, type Segment, type Transcript } from './segments'
import styles from './TranscriptView.module.css'

interface TranscriptViewProps {
  recordingId: string
  transcript: Transcript
}

export function TranscriptView({ recordingId, transcript }: TranscriptViewProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const [currentMs, setCurrentMs] = useState(0)
  const [follow, setFollow] = useState(true)
  const { segments, speakers } = transcript
  const active = findSegmentAt(segments, currentMs)
  const withHours = transcript.duration_ms >= 3_600_000

  useEffect(() => {
    if (!follow || active < 0) return
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [active, follow])

  function seek(ms: number) {
    const audio = audioRef.current
    setCurrentMs(ms)
    if (!audio) return
    audio.currentTime = ms / 1000
    // O navegador pode recusar o play (política de autoplay); o posicionamento vale mesmo assim.
    audio.play().catch(() => {})
  }

  function onSegmentClick(event: MouseEvent<HTMLLIElement>, segment: Segment) {
    // Botões e campos dentro do segmento têm ação própria.
    if ((event.target as HTMLElement).closest('button, textarea, input, a')) return
    seek(segment.start_ms)
  }

  return (
    <div className={styles.view}>
      <div className={styles.player}>
        <audio
          ref={audioRef}
          className={styles.audio}
          controls
          preload="metadata"
          src={`/api/v1/recordings/${recordingId}/audio`}
          onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)}
          aria-label="Áudio da gravação"
        />
        <label className={styles.follow}>
          <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
          Acompanhar o áudio
        </label>
      </div>

      {segments.length === 0 ? (
        <p className="muted">A transcrição não tem falas.</p>
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
                    onClick={() => seek(segment.start_ms)}
                    aria-label={`Ouvir a partir de ${clock}, fala de ${name}`}
                  >
                    {clock}
                  </button>
                </div>
                <p className={styles.text}>{segment.text}</p>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
