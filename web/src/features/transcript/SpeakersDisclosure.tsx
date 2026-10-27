import type { ReactNode } from 'react'

import { speakerColorIndex, speakerName, type Transcript } from './segments'
import styles from './SpeakersPanel.module.css'
import { SpeakersPanel } from './SpeakersPanel'

interface SpeakersDisclosureProps {
  transcript: Transcript
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What comes before the cards, when open: a notice about the speakers, for example. */
  children?: ReactNode
}

/**
 * The speakers in their own collapsed block (`details.disclosure`), outside the transcript. Collapsed, the
 * summary shows each speaker inline, in its color; open, one card per speaker in a grid, with
 * rename, link person, voice suggestions and merge.
 */
export function SpeakersDisclosure({ transcript, open, onOpenChange, children }: SpeakersDisclosureProps) {
  const { speakers } = transcript
  return (
    <details
      className={`disclosure ${styles.disclosure}`}
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) onOpenChange(event.currentTarget.open)
      }}
    >
      <summary>
        Locutores
        {open ? (
          <span className="text-muted">renomeie, ligue a pessoas ou junte</span>
        ) : (
          <span className={styles.inline}>
            {speakers.map((speaker) => (
              <span key={speaker.id} className={`speaker speaker-${speakerColorIndex(speakers, speaker.id)}`}>
                {speakerName(speaker)}
              </span>
            ))}
          </span>
        )}
      </summary>
      {open && (
        <div className={styles.body}>
          {children}
          <SpeakersPanel transcript={transcript} />
        </div>
      )}
    </details>
  )
}
