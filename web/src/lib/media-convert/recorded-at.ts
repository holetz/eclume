// The recording start read from the file itself, before conversion: the converted Opus does not carry the
// original's metadata. Sources, in order: the `mvhd` `creation_time` (MP4, MOV, M4A), the Matroska/WebM
// `DateUTC`, the date tags Mediabunny exposes and, last, the modification date.

export interface RecordedAt {
  at: Date
  /** `metadata`: read from the file; `file_date`: no date in the file, the modification date is used. */
  source: 'metadata' | 'file_date'
  /** `day`: the source carried only the day; the time came from the modification date or is 12:00. */
  precision: 'minute' | 'day'
  /** Where the value came from (`mvhd`, `DateUTC`, the tag read or `lastModified`). */
  detail: string
}

interface ReadRecordedAtOptions {
  /** "Now", to discard dates in the future. */
  now?: Date
  /** Reads the file's date tags; the default uses Mediabunny, loaded on demand. */
  readTags?: (file: Blob) => Promise<DateTag | null>
}

/** A date read from the tags: the raw text (when there is one) and the `Date` the demuxer already parsed. */
export interface DateTag {
  key: string
  raw: string | null
  date: Date | null
}

const DAY_MS = 86_400_000
const MP4_EPOCH_MS = Date.UTC(1904, 0, 1)
const MATROSKA_EPOCH_MS = Date.UTC(2001, 0, 1)
const OLDEST_MS = Date.UTC(1990, 0, 1)
const MATROSKA_SCAN_BYTES = 256 * 1024
const MAX_BOXES = 4096
const MP4_TOP_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid', 'meta'])

async function view(file: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await file.slice(start, Math.min(end, file.size)).arrayBuffer())
}

function fourcc(data: DataView, offset: number): string {
  return String.fromCharCode(...[0, 1, 2, 3].map((index) => data.getUint8(offset + index)))
}

function plausible(date: Date | null, now: Date): date is Date {
  if (!date || Number.isNaN(date.getTime())) return false
  return date.getTime() >= OLDEST_MS && date.getTime() <= now.getTime() + DAY_MS
}

interface Box {
  type: string
  start: number
  headerSize: number
  end: number
}

/** Reads the header of an MP4 box (32- or 64-bit size; 0 = up to the end of the parent). */
async function readBox(file: Blob, offset: number, parentEnd: number): Promise<Box | null> {
  if (offset + 8 > parentEnd) return null
  const header = await view(file, offset, offset + 16)
  if (header.byteLength < 8) return null
  let size = header.getUint32(0)
  let headerSize = 8
  if (size === 1) {
    if (header.byteLength < 16) return null
    size = Number(header.getBigUint64(8))
    headerSize = 16
  } else if (size === 0) {
    size = parentEnd - offset
  }
  if (size < headerSize) return null
  return { type: fourcc(header, 4), start: offset, headerSize, end: Math.min(offset + size, parentEnd) }
}

/**
 * The `moov/mvhd` `creation_time`, in seconds since 1904-01-01 UTC (versions 0 and 1). Walks the
 * top-level boxes in 16-byte slices, because the `moov` may be at the end of the file.
 */
export async function readMp4CreationTime(file: Blob): Promise<Date | null> {
  let offset = 0
  for (let count = 0; count < MAX_BOXES; count++) {
    const box = await readBox(file, offset, file.size)
    if (!box || (offset === 0 && !MP4_TOP_BOXES.has(box.type))) return null
    if (box.type === 'moov') {
      let child = box.start + box.headerSize
      for (let inner = 0; inner < MAX_BOXES; inner++) {
        const mvhd = await readBox(file, child, box.end)
        if (!mvhd) return null
        if (mvhd.type === 'mvhd') {
          const body = await view(file, mvhd.start + mvhd.headerSize, mvhd.start + mvhd.headerSize + 12)
          if (body.byteLength < 8) return null
          const seconds = body.getUint8(0) === 1 ? Number(body.getBigUint64(4)) : body.getUint32(4)
          return seconds === 0 ? null : new Date(MP4_EPOCH_MS + seconds * 1000)
        }
        child = mvhd.end
      }
      return null
    }
    offset = box.end
  }
  return null
}

/** The `DateUTC` (ID 0x4461, nanoseconds since 2001-01-01 UTC) of a Matroska or WebM `Info`. */
export async function readMatroskaDate(file: Blob): Promise<Date | null> {
  const data = await view(file, 0, MATROSKA_SCAN_BYTES)
  if (data.byteLength < 4 || data.getUint32(0) !== 0x1a45dfa3) return null
  for (let index = 4; index + 11 <= data.byteLength; index++) {
    // 2-byte ID followed by size 8 as a 1-byte VINT (0x88).
    if (data.getUint8(index) === 0x44 && data.getUint8(index + 1) === 0x61 && data.getUint8(index + 2) === 0x88) {
      const nanoseconds = data.getBigInt64(index + 3)
      return new Date(MATROSKA_EPOCH_MS + Number(nanoseconds / 1_000_000n))
    }
  }
  return null
}

const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/

/** Parses a tag's text: day only, date and time without a zone (local time) or with a zone. */
function parseTagText(text: string): { date: Date; dayOnly: boolean } | null {
  const value = text.trim()
  const day = DAY_ONLY.exec(value)
  if (day) return { date: new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])), dayOnly: true }
  const local = LOCAL_TIME.exec(value)
  if (local) {
    const [, y, m, d, h, min, s] = local
    return { date: new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(s ?? 0)), dayOnly: false }
  }
  const zoned = new Date(value)
  return Number.isNaN(zoned.getTime()) || !/\d{2}:\d{2}/.test(value) ? null : { date: zoned, dayOnly: false }
}

const DATE_KEYS = ['com.apple.quicktime.creationdate', 'TDRC', 'TDOR', 'TYER', '©day', 'DATE', 'date', 'ICRD', 'creation_time']

/** The date tags through Mediabunny (ID3 `TDRC`, `©day`, QuickTime `creationdate`, Vorbis `DATE`, WAV `ICRD`). */
async function readTagsWithMediabunny(file: Blob): Promise<DateTag | null> {
  const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny')
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    if (!(await input.canRead())) return null
    const tags = await input.getMetadataTags()
    const raw = tags.raw ?? {}
    for (const key of DATE_KEYS) {
      const value = raw[key]
      const text = Array.isArray(value) ? value[0] : value
      if (typeof text === 'string' && text.trim()) return { key, raw: text, date: tags.date ?? null }
    }
    return tags.date ? { key: 'date', raw: null, date: tags.date } : null
  } catch {
    return null
  } finally {
    input.dispose()
  }
}

/** Day only: the time comes from the modification date when it is the same local day; otherwise, 12:00. */
function withTimeOfDay(day: Date, modified: Date): Date {
  const sameDay =
    day.getFullYear() === modified.getFullYear() &&
    day.getMonth() === modified.getMonth() &&
    day.getDate() === modified.getDate()
  return sameDay ? modified : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12)
}

function fileDate(file: Blob): Date {
  return new Date(file instanceof File ? file.lastModified : Date.now())
}

/**
 * The recording start: from the metadata when there is a plausible date (from 1990 up to one day ahead),
 * otherwise the file's modification date. Never rejects: a read failure becomes the fallback.
 */
export async function readRecordedAt(file: Blob, options: ReadRecordedAtOptions = {}): Promise<RecordedAt> {
  const now = options.now ?? new Date()
  const modified = fileDate(file)
  const readers: [string, () => Promise<Date | null>][] = [
    ['mvhd', () => readMp4CreationTime(file)],
    ['DateUTC', () => readMatroskaDate(file)],
  ]
  for (const [detail, read] of readers) {
    const date = await read().catch(() => null)
    if (plausible(date, now)) return { at: date, source: 'metadata', precision: 'minute', detail }
  }

  const tag = await (options.readTags ?? readTagsWithMediabunny)(file).catch(() => null)
  if (tag) {
    const parsed = tag.raw ? parseTagText(tag.raw) : null
    const date = parsed?.date ?? tag.date
    const dayOnly = parsed?.dayOnly ?? false
    const at = date && dayOnly ? withTimeOfDay(date, modified) : date
    if (plausible(at, now)) return { at, source: 'metadata', precision: dayOnly ? 'day' : 'minute', detail: tag.key }
  }
  return { at: modified, source: 'file_date', precision: 'minute', detail: 'lastModified' }
}
