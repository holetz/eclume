// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readMatroskaDate, readMp4CreationTime, readRecordedAt, type DateTag } from './recorded-at'

const NOW = new Date('2026-09-27T12:00:00Z')
const MP4_EPOCH_S = Date.UTC(1904, 0, 1) / 1000

function box(type: string, body: Uint8Array, { large = false } = {}): Uint8Array<ArrayBuffer> {
  const header = large ? 16 : 8
  const out = new Uint8Array(header + body.length)
  const data = new DataView(out.buffer)
  if (large) {
    data.setUint32(0, 1)
    data.setBigUint64(8, BigInt(out.length))
  } else {
    data.setUint32(0, out.length)
  }
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(body, header)
  return out
}

function mvhd(iso: string | null, version: 0 | 1 = 0): Uint8Array<ArrayBuffer> {
  const seconds = iso === null ? 0 : Date.parse(iso) / 1000 - MP4_EPOCH_S
  const body = new Uint8Array(version === 1 ? 28 : 16)
  const data = new DataView(body.buffer)
  data.setUint8(0, version)
  if (version === 1) data.setBigUint64(4, BigInt(seconds))
  else data.setUint32(4, seconds)
  return box('mvhd', body)
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function file(bytes: Uint8Array<ArrayBuffer>, lastModified = Date.parse('2026-09-20T18:30:00Z')): File {
  return new File([bytes], 'reuniao.bin', { lastModified })
}

const ftyp = box('ftyp', new TextEncoder().encode('isom\0\0\0\0isom'))

function matroska(iso: string | null): Uint8Array<ArrayBuffer> {
  const head = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]
  const info = [0x15, 0x49, 0xa9, 0x66, 0x8e, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]
  if (iso === null) return new Uint8Array([...head, ...info])
  const date = new Uint8Array(11)
  date.set([0x44, 0x61, 0x88])
  new DataView(date.buffer).setBigInt64(3, BigInt(Date.parse(iso) - Date.UTC(2001, 0, 1)) * 1_000_000n)
  return new Uint8Array([...head, ...info, ...date])
}

const noTags = async () => null

describe('MP4 creation_time', () => {
  it('reads mvhd versions 0 and 1, with the moov at the end and after a 64-bit mdat', async () => {
    const mdat = box('mdat', new Uint8Array(4096), { large: true })
    const late = concat(ftyp, mdat, box('moov', concat(box('trak', new Uint8Array(8)), mvhd('2026-09-19T14:02:00Z'))))
    expect(await readMp4CreationTime(file(late))).toEqual(new Date('2026-09-19T14:02:00Z'))
    const v1 = concat(ftyp, box('moov', mvhd('2026-09-24T19:30:00Z', 1)))
    expect(await readMp4CreationTime(file(v1))).toEqual(new Date('2026-09-24T19:30:00Z'))
  })

  it('invents no date: zero, a file that is not MP4 or a truncated box', async () => {
    expect(await readMp4CreationTime(file(concat(ftyp, box('moov', mvhd(null)))))).toBeNull()
    expect(await readMp4CreationTime(file(new TextEncoder().encode('ID3 is not an mp4 file at all')))).toBeNull()
    expect(await readMp4CreationTime(file(concat(ftyp, box('moov', mvhd('2026-09-19T14:02:00Z'))).slice(0, 30)))).toBeNull()
  })
})

describe('Matroska DateUTC', () => {
  it('reads the Info DateUTC', async () => {
    expect(await readMatroskaDate(file(matroska('2026-09-23T16:00:00Z')))).toEqual(new Date('2026-09-23T16:00:00Z'))
  })

  it('without the element or without the EBML, there is no date', async () => {
    expect(await readMatroskaDate(file(matroska(null)))).toBeNull()
    expect(await readMatroskaDate(file(concat(ftyp)))).toBeNull()
  })
})

describe('readRecordedAt', () => {
  it('prefers the metadata, in UTC', async () => {
    const mp4 = file(concat(ftyp, box('moov', mvhd('2026-09-19T14:02:00Z'))))
    expect(await readRecordedAt(mp4, { now: NOW, readTags: noTags })).toEqual({
      at: new Date('2026-09-19T14:02:00Z'),
      source: 'metadata',
      precision: 'minute',
      detail: 'mvhd',
    })
    const mkv = await readRecordedAt(file(matroska('2026-09-23T16:00:00Z')), { now: NOW, readTags: noTags })
    expect(mkv).toMatchObject({ at: new Date('2026-09-23T16:00:00Z'), source: 'metadata', detail: 'DateUTC' })
  })

  it('discards zeroed dates, dates before 1990 or in the future and falls back to the modification date', async () => {
    const modified = Date.parse('2026-09-20T18:30:00Z')
    for (const iso of ['1970-01-01T00:00:00Z', '1989-12-31T23:00:00Z', '2026-09-29T12:00:00Z']) {
      const result = await readRecordedAt(file(concat(ftyp, box('moov', mvhd(iso))), modified), {
        now: NOW,
        readTags: noTags,
      })
      expect(result).toEqual({ at: new Date(modified), source: 'file_date', precision: 'minute', detail: 'lastModified' })
    }
  })

  it('uses the file tags: local time without a zone, with a zone and day only', async () => {
    const tag = (raw: string, key = 'TDRC') => async (): Promise<DateTag> => ({ key, raw, date: null })
    const empty = file(new Uint8Array(16), new Date(2026, 8, 19, 9, 41).getTime())

    const local = await readRecordedAt(empty, { now: NOW, readTags: tag('2026-09-18 15:20') })
    expect(local).toEqual({ at: new Date(2026, 8, 18, 15, 20), source: 'metadata', precision: 'minute', detail: 'TDRC' })

    const zoned = await readRecordedAt(empty, {
      now: NOW,
      readTags: tag('2026-09-18T15:20:00-0300', 'com.apple.quicktime.creationdate'),
    })
    expect(zoned.at).toEqual(new Date('2026-09-18T18:20:00Z'))

    // Day only, the same as the modification: the time comes from the modification.
    const sameDay = await readRecordedAt(empty, { now: NOW, readTags: tag('2026-09-19', 'DATE') })
    expect(sameDay).toEqual({ at: new Date(2026, 8, 19, 9, 41), source: 'metadata', precision: 'day', detail: 'DATE' })
    // Day only, another day: noon.
    const otherDay = await readRecordedAt(empty, { now: NOW, readTags: tag('2026-09-15', 'ICRD') })
    expect(otherDay).toMatchObject({ at: new Date(2026, 8, 15, 12), precision: 'day' })

    // Without text, the Date the demuxer parsed applies.
    const parsed = await readRecordedAt(empty, {
      now: NOW,
      readTags: async () => ({ key: 'date', raw: null, date: new Date('2026-09-10T10:00:00Z') }),
    })
    expect(parsed).toMatchObject({ at: new Date('2026-09-10T10:00:00Z'), source: 'metadata', precision: 'minute' })
  })

  it('an unreadable tag or a failing read becomes the modification date', async () => {
    const modified = new Date(2026, 8, 19, 9, 41)
    const blank = file(new Uint8Array(16), modified.getTime())
    const unreadable = await readRecordedAt(blank, {
      now: NOW,
      readTags: async () => ({ key: 'TYER', raw: 'last year', date: null }),
    })
    expect(unreadable).toMatchObject({ at: modified, source: 'file_date' })
    const failing = await readRecordedAt(blank, {
      now: NOW,
      readTags: async () => {
        throw new Error('demuxer')
      },
    })
    expect(failing).toMatchObject({ at: modified, source: 'file_date' })
  })
})
