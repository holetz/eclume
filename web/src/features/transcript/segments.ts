// Pure transcript functions: types, current segment by time and clock.
import type { operations } from '../../api/schema.gen'

export type Transcript = operations['getTranscript']['responses'][200]['content']['application/json']
export type Segment = Transcript['segments'][number]
export type Speaker = Transcript['speakers'][number]

/**
 * Index of the current segment at instant `ms`: the last one that has already started. Between two segments the
 * highlight stays on the previous one until the next starts. Before the first, -1. The segments come in
 * `start_ms` order (contract).
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

/** The speaker's displayed name: the linked person or, without a person, the label. */
export function speakerName(speaker: Pick<Speaker, 'label' | 'person'> | undefined): string {
  if (!speaker) return 'Locutor desconhecido'
  return speaker.person?.name ?? speaker.label
}

/** Stable color per speaker (1..6), by position in the speakers list. */
export function speakerColorIndex(speakers: readonly Pick<Speaker, 'id'>[], speakerId: string): number {
  const index = speakers.findIndex((s) => s.id === speakerId)
  return index < 0 ? 0 : (index % 6) + 1
}

/** `?t=` from the URL (whole milliseconds), or `null` if absent or invalid. */
export function parseStart(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null
  return Number(value)
}
