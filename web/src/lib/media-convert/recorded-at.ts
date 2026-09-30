// O início da gravação lido do próprio arquivo, antes da conversão: o Opus convertido não carrega os
// metadados do original. Fontes, em ordem: `creation_time` do `mvhd` (MP4, MOV, M4A), `DateUTC` do
// Matroska/WebM, as tags de data que o Mediabunny expõe e, por fim, a data de modificação.

export interface RecordedAt {
  at: Date
  /** `metadata`: lida do arquivo; `file_date`: sem data no arquivo, usa a de modificação. */
  source: 'metadata' | 'file_date'
  /** `day`: a fonte só trazia o dia; a hora veio da data de modificação ou é 12:00. */
  precision: 'minute' | 'day'
  /** De onde veio o valor (`mvhd`, `DateUTC`, a tag lida ou `lastModified`). */
  detail: string
}

interface ReadRecordedAtOptions {
  /** "Agora", para descartar datas no futuro. */
  now?: Date
  /** Lê as tags de data do arquivo; o padrão usa o Mediabunny, carregado sob demanda. */
  readTags?: (file: Blob) => Promise<DateTag | null>
}

/** Uma data lida das tags: o texto cru (quando há) e o `Date` que o demuxer já interpretou. */
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

/** Lê o cabeçalho de uma caixa MP4 (tamanho de 32 ou 64 bits; 0 = até o fim do pai). */
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
 * O `creation_time` do `moov/mvhd`, em segundos desde 1904-01-01 UTC (versões 0 e 1). Percorre as
 * caixas de topo por fatias de 16 bytes, porque o `moov` pode estar no fim do arquivo.
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

/** O `DateUTC` (ID 0x4461, nanossegundos desde 2001-01-01 UTC) do `Info` de um Matroska ou WebM. */
export async function readMatroskaDate(file: Blob): Promise<Date | null> {
  const data = await view(file, 0, MATROSKA_SCAN_BYTES)
  if (data.byteLength < 4 || data.getUint32(0) !== 0x1a45dfa3) return null
  for (let index = 4; index + 11 <= data.byteLength; index++) {
    // ID de 2 bytes seguido do tamanho 8 em VINT de 1 byte (0x88).
    if (data.getUint8(index) === 0x44 && data.getUint8(index + 1) === 0x61 && data.getUint8(index + 2) === 0x88) {
      const nanoseconds = data.getBigInt64(index + 3)
      return new Date(MATROSKA_EPOCH_MS + Number(nanoseconds / 1_000_000n))
    }
  }
  return null
}

const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/

/** Interpreta o texto de uma tag: só o dia, data e hora sem fuso (hora local) ou com fuso. */
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

/** As tags de data pelo Mediabunny (ID3 `TDRC`, `©day`, QuickTime `creationdate`, Vorbis `DATE`, WAV `ICRD`). */
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

/** Dia só: a hora vem da data de modificação quando é o mesmo dia local; senão, 12:00. */
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
 * O início da gravação: dos metadados quando há uma data plausível (de 1990 até um dia no futuro),
 * senão a data de modificação do arquivo. Nunca rejeita: falha de leitura vira o fallback.
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
