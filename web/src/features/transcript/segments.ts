// Funções puras da transcrição: tipos, segmento corrente pelo tempo e relógio.
import type { operations } from '../../api/schema.gen'

export type Transcript = operations['getTranscript']['responses'][200]['content']['application/json']
export type Segment = Transcript['segments'][number]
export type Speaker = Transcript['speakers'][number]

/**
 * Índice do segmento corrente no instante `ms`: o último que já começou. Entre duas falas o
 * destaque fica na anterior até a próxima começar. Antes da primeira, -1. Os segmentos vêm em
 * ordem de `start_ms` (contrato).
 */
export function findSegmentAt(segments: readonly Pick<Segment, 'start_ms'>[], ms: number): number {
  let low = 0
  let high = segments.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (segments[mid].start_ms <= ms) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

/** "02:46" ou, com `withHours`, "0:02:46". */
export function formatClock(ms: number, withHours = false): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mmss = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return withHours || hours > 0 ? `${hours}:${mmss}` : mmss
}

/** Nome exibido do locutor: a pessoa ligada ou, sem pessoa, o rótulo. */
export function speakerName(speaker: Pick<Speaker, 'label' | 'person'> | undefined): string {
  if (!speaker) return 'Locutor desconhecido'
  return speaker.person?.name ?? speaker.label
}

/** Cor estável por locutor (1..6), pela posição na lista de locutores. */
export function speakerColorIndex(speakers: readonly Pick<Speaker, 'id'>[], speakerId: string): number {
  const index = speakers.findIndex((s) => s.id === speakerId)
  return index < 0 ? 0 : (index % 6) + 1
}
