// The People table columns the user chooses to show. The name is fixed; the choice stays in this
// browser, in localStorage, like the Ambiente preferences.
import { readStored, STORAGE_KEYS, writeStored } from '../../app/storage'
import { i18n } from '../../i18n'

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
const column = (key: PersonColumn) => ({
  key,
  get label() {
    return i18n.t(`people:column.${key}`)
  },
})

export const PERSON_COLUMNS: readonly { key: PersonColumn; readonly label: string }[] = [
  column('company'),
  column('department'),
  column('job_title'),
  column('tags'),
  column('email'),
  column('phone'),
  column('transcript_count'),
  column('voice_sample_count'),
  column('last_seen_at'),
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
