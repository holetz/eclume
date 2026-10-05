import type { ReactNode } from 'react'

import { speakerColorIndex, speakerName, type Transcript } from './segments'
import styles from './SpeakersPanel.module.css'
import { SpeakersPanel } from './SpeakersPanel'

interface SpeakersDisclosureProps {
  transcript: Transcript
  open: boolean
  onOpenChange: (open: boolean) => void
  /** O que vem antes dos cards, aberto: um aviso sobre os locutores, por exemplo. */
  children?: ReactNode
}

/**
 * Os locutores num bloco recolhido próprio (`details.disclosure`), fora da transcrição. Recolhido, o
 * resumo mostra cada locutor em linha, na cor dele; aberto, um card por locutor em grade, com
 * renomear, ligar pessoa, sugestões por voz e mesclar.
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
