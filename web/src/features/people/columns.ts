// As colunas da tabela de Pessoas que o usuário escolhe mostrar. O nome é fixo; a escolha fica neste
// navegador, no localStorage, como as preferências do Ambiente.
import { readStored, STORAGE_KEYS, writeStored } from '../../app/storage'

export type PersonColumn =
  | 'organization'
  | 'department'
  | 'job_title'
  | 'tags'
  | 'email'
  | 'phone'
  | 'transcript_count'
  | 'voice_sample_count'
  | 'last_seen_at'

/** Todas as colunas, na ordem da tabela, com o rótulo do cabeçalho e do menu Colunas. */
export const PERSON_COLUMNS: readonly { key: PersonColumn; label: string }[] = [
  { key: 'organization', label: 'Organização' },
  { key: 'department', label: 'Área' },
  { key: 'job_title', label: 'Cargo' },
  { key: 'tags', label: 'Tags' },
  { key: 'email', label: 'E-mail' },
  { key: 'phone', label: 'Telefone' },
  { key: 'transcript_count', label: 'Gravações' },
  { key: 'voice_sample_count', label: 'Amostras de voz' },
  { key: 'last_seen_at', label: 'Última gravação' },
]

/** O padrão esconde e-mail, telefone, cargo e a última gravação: o e-mail quase nunca importa. */
export const DEFAULT_PERSON_COLUMNS: readonly PersonColumn[] = [
  'organization',
  'department',
  'tags',
  'transcript_count',
  'voice_sample_count',
]

const KEYS = PERSON_COLUMNS.map((column) => column.key)

/** As colunas guardadas, na ordem da tabela; sem valor guardado (ou só lixo), o padrão. */
export function readPersonColumns(): PersonColumn[] {
  const stored = readStored(STORAGE_KEYS.peopleColumns)
  if (stored === null) return [...DEFAULT_PERSON_COLUMNS]
  const chosen = new Set(stored.split(','))
  // Guardado vazio é escolha válida: só o nome.
  if (stored !== '' && !KEYS.some((key) => chosen.has(key))) return [...DEFAULT_PERSON_COLUMNS]
  return KEYS.filter((key) => chosen.has(key))
}

/** Grava a escolha; igual ao padrão, apaga a chave. */
export function savePersonColumns(columns: PersonColumn[]): void {
  const ordered = KEYS.filter((key) => columns.includes(key))
  const isDefault = ordered.join(',') === DEFAULT_PERSON_COLUMNS.join(',')
  writeStored(STORAGE_KEYS.peopleColumns, isDefault ? null : ordered.join(','))
}
