// O início da gravação lido das fixtures reais (scripts/media-fixtures.sh), em Chrome headless
// (npm run test:browser, no host de build): a data vem dos metadados do original, que a conversão
// para Opus não carrega.
import { describe, expect, it } from 'vitest'
import { convertAudio, readRecordedAt } from './index'

const CREATED = new Date('2026-09-19T14:02:00Z')

async function fixture(name: string): Promise<File> {
  const response = await fetch(`/src/lib/media-convert/__fixtures__/${name}`)
  if (!response.ok) throw new Error(`fixture ausente: ${name} (rode npm run fixtures)`)
  // A data de modificação fica num dia diferente do da tag, para a precisão de dia usar 12:00.
  return new File([await response.blob()], name, { lastModified: Date.parse('2026-09-25T10:00:00Z') })
}

describe('início da gravação nas fixtures reais', () => {
  it.each([
    ['video.mp4', 'mvhd'],
    ['video.mov', 'mvhd'],
    ['audio.m4a', 'mvhd'],
    ['video.mkv', 'DateUTC'],
  ])('%s traz o creation_time pelo %s', async (name, detail) => {
    expect(await readRecordedAt(await fixture(name))).toEqual({
      at: CREATED,
      source: 'metadata',
      precision: 'minute',
      detail,
    })
  })

  it('audio.mp3 traz só o dia na tag ID3, e a hora fica 12:00', async () => {
    const result = await readRecordedAt(await fixture('audio.mp3'))
    expect(result).toMatchObject({ source: 'metadata', precision: 'day' })
    expect(result.at).toEqual(new Date(2026, 8, 19, 12))
  })

  it('audio.wav não tem data: vale a de modificação', async () => {
    expect(await readRecordedAt(await fixture('audio.wav'))).toEqual({
      at: new Date('2026-09-25T10:00:00Z'),
      source: 'file_date',
      precision: 'minute',
      detail: 'lastModified',
    })
  })

  it('o Opus convertido perde a data: por isso a leitura vem antes da conversão', async () => {
    const original = await fixture('audio.m4a')
    const before = await readRecordedAt(original)
    const { blob } = await convertAudio(original)
    const converted = new File([blob], 'audio.ogg', { lastModified: Date.parse('2026-09-26T08:00:00Z') })
    expect(before.source).toBe('metadata')
    expect(await readRecordedAt(converted)).toMatchObject({ source: 'file_date' })
  })
})
