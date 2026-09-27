import { describe, expect, it } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { commonDevice, currentMarkerId, hms, placeMarkers } from './markers'

const markers = () => fixtures.markerPage().items

describe('marcadores', () => {
  it('escreve o instante em HH:MM:SS', () => {
    expect(hms(0)).toBe('00:00:00')
    expect(hms(42_000)).toBe('00:00:42')
    expect(hms(760_999)).toBe('00:12:40')
    expect(hms(4_324_000)).toBe('01:12:04')
  })

  it('põe cada marcador antes da primeira fala que começa nele ou depois, ou no fim', () => {
    const segments = [{ start_ms: 0 }, { start_ms: 40_000 }, { start_ms: 42_000 }, { start_ms: 90_000 }]
    expect(placeMarkers(segments, [{ at_ms: 0 }, { at_ms: 41_000 }, { at_ms: 42_000 }, { at_ms: 95_000 }])).toEqual([
      0, 2, 2, 4,
    ])
    expect(placeMarkers([], [{ at_ms: 10 }])).toEqual([0])
  })

  it('o corrente é o último já passado', () => {
    const [first, second] = markers()
    expect(currentMarkerId(markers(), 10_000)).toBeNull()
    expect(currentMarkerId(markers(), first.at_ms)).toBe(first.id)
    expect(currentMarkerId(markers(), 200_000)).toBe(second.id)
  })

  it('diz o dispositivo só quando todos vieram do mesmo', () => {
    expect(commonDevice(markers())).toBe('NB-MARIANA')
    expect(commonDevice([{ device_name: 'NB-MARIANA' }, { device_name: 'iPhone 15' }])).toBeNull()
    expect(commonDevice([{ device_name: null }])).toBeNull()
    expect(commonDevice([])).toBeNull()
  })
})
