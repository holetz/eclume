// The recording start read from the real fixtures (scripts/media-fixtures.sh), in headless Chrome, Firefox and
// WebKit (npm run test:browser, on the build host): the date comes from the original's metadata,
// which the conversion to Opus does not carry. Reading the date decodes nothing: it holds for any engine.
import { describe, expect, it } from 'vitest'
import { convertAudio, readRecordedAt } from './index'

const CREATED = new Date('2026-09-19T14:02:00Z')

async function fixture(name: string): Promise<File> {
  const response = await fetch(`/src/lib/media-convert/__fixtures__/${name}`)
  if (!response.ok) throw new Error(`missing fixture: ${name} (run npm run fixtures)`)
  // The modification date falls on a different day from the tag's, so the day precision uses 12:00.
  return new File([await response.blob()], name, { lastModified: Date.parse('2026-09-25T10:00:00Z') })
}

describe('recording start in the real fixtures', () => {
  it.each([
    ['video.mp4', 'mvhd'],
    ['video.mov', 'mvhd'],
    ['audio.m4a', 'mvhd'],
    ['video.mkv', 'DateUTC'],
  ])('%s carries the creation_time through %s', async (name, detail) => {
    expect(await readRecordedAt(await fixture(name))).toEqual({
      at: CREATED,
      source: 'metadata',
      precision: 'minute',
      detail,
    })
  })

  it('audio.mp3 carries only the day in the ID3 tag, and the time becomes 12:00', async () => {
    const result = await readRecordedAt(await fixture('audio.mp3'))
    expect(result).toMatchObject({ source: 'metadata', precision: 'day' })
    expect(result.at).toEqual(new Date(2026, 8, 19, 12))
  })

  it('audio.wav has no date: the modification date applies', async () => {
    expect(await readRecordedAt(await fixture('audio.wav'))).toEqual({
      at: new Date('2026-09-25T10:00:00Z'),
      source: 'file_date',
      precision: 'minute',
      detail: 'lastModified',
    })
  })

  it('the converted Opus loses the date: that is why the read comes before the conversion', async () => {
    const original = await fixture('audio.m4a')
    const before = await readRecordedAt(original)
    const { blob } = await convertAudio(original)
    const converted = new File([blob], 'audio.ogg', { lastModified: Date.parse('2026-09-26T08:00:00Z') })
    expect(before.source).toBe('metadata')
    expect(await readRecordedAt(converted)).toMatchObject({ source: 'file_date' })
  })
})
