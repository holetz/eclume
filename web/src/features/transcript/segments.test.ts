import { describe, expect, it } from 'vitest'
import { findSegmentAt, formatClock, speakerColorIndex, speakerName } from './segments'

const segments = [{ start_ms: 3200 }, { start_ms: 12_400 }, { start_ms: 24_600 }, { start_ms: 39_500 }]

describe('findSegmentAt', () => {
  it('acha o último segmento que já começou', () => {
    expect(findSegmentAt(segments, 0)).toBe(-1)
    expect(findSegmentAt(segments, 3199)).toBe(-1)
    expect(findSegmentAt(segments, 3200)).toBe(0)
    expect(findSegmentAt(segments, 12_000)).toBe(0)
    expect(findSegmentAt(segments, 12_400)).toBe(1)
    expect(findSegmentAt(segments, 30_000)).toBe(2)
    expect(findSegmentAt(segments, 1_000_000)).toBe(3)
    expect(findSegmentAt([], 10)).toBe(-1)
  })
})

describe('formatos da transcrição', () => {
  it('formata o relógio', () => {
    expect(formatClock(3200)).toBe('00:03')
    expect(formatClock(163_500)).toBe('02:43')
    expect(formatClock(163_500, true)).toBe('0:02:43')
    expect(formatClock(3_723_000)).toBe('1:02:03')
  })

  it('nomeia e colore locutores', () => {
    const speakers = [{ id: 'S1' }, { id: 'S2' }]
    expect(speakerColorIndex(speakers, 'S2')).toBe(2)
    expect(speakerColorIndex(speakers, 'S9')).toBe(0)
    expect(speakerName({ label: 'Locutor 2', person: null })).toBe('Locutor 2')
    expect(speakerName({ label: 'Locutor 2', person: { id: 'p', name: 'Rafael Lima' } })).toBe('Rafael Lima')
    expect(speakerName(undefined)).toBe('Locutor desconhecido')
  })
})
