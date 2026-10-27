// The People table columns the user chooses to show. The name is fixed; the choice stays in this
// browser, in localStorage, like the Ambiente preferences.
import { readStored, STORAGE_KEYS, writeStored } from '../../app/storage'

export type PersonColumn =
  | 'company'
  | 'department'
  | 'job_title'
  | 'tags'
  | 'email'
  | 'phone'
  | 'transcript_count'
  | 'voice_sample_count'
  | 'last_seen_at'

/** All the columns, in table order, with the label of the header and of the Colunas menu. */
export const PERSON_COLUMNS: readonly { key: PersonColumn; label: string }[] = [
  { key: 'company', label: 'Empresa' },
  { key: 'department', label: 'Área' },
  { key: 'job_title', label: 'Cargo' },
  { key: 'tags', label: 'Tags' },
  { key: 'email', label: 'E-mail' },
  { key: 'phone', label: 'Telefone' },
  { key: 'transcript_count', label: 'Gravações' },
  { key: 'voice_sample_count', label: 'Amostras de voz' },
  { key: 'last_seen_at', label: 'Última gravação' },
]

/** The default hides e-mail, phone, role and the last recording: the e-mail hardly ever matters. */
export const DEFAULT_PERSON_COLUMNS: readonly PersonColumn[] = [
  'company',
  'department',
  'tags',
  'transcript_count',
  'voice_sample_count',
]

const KEYS = PERSON_COLUMNS.map((column) => column.key)

/** The stored columns, in table order; with no stored value (or only garbage), the default. */
export function readPersonColumns(): PersonColumn[] {
  const stored = readStored(STORAGE_KEYS.peopleColumns)
  if (stored === null) return [...DEFAULT_PERSON_COLUMNS]
  const chosen = new Set(stored.split(','))
  // A stored empty value is a valid choice: only the name.
  if (stored !== '' && !KEYS.some((key) => chosen.has(key))) return [...DEFAULT_PERSON_COLUMNS]
  return KEYS.filter((key) => chosen.has(key))
}

/** Saves the choice; equal to the default, it deletes the key. */
export function savePersonColumns(columns: PersonColumn[]): void {
  const ordered = KEYS.filter((key) => columns.includes(key))
  const isDefault = ordered.join(',') === DEFAULT_PERSON_COLUMNS.join(',')
  writeStored(STORAGE_KEYS.peopleColumns, isDefault ? null : ordered.join(','))
}
