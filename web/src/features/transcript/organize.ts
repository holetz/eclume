// Organização da gravação: tags, coleções e os metadados de organização (RecordingMetadata).
export const METADATA_FIELDS = [
  { key: 'tipo_reuniao', label: 'Tipo de reunião' },
  { key: 'cliente', label: 'Cliente' },
  { key: 'projeto', label: 'Projeto' },
] as const

export type MetadataKey = (typeof METADATA_FIELDS)[number]['key']

export const MEETING_TYPES = ['alinhamento', 'entrevista', 'feedback', 'workshop', 'kickoff', 'devolutiva']

/** "a, b,, a " → ["a", "b"]: sem vazios nem repetidos, na ordem digitada. */
export function parseTags(value: string): string[] {
  return [...new Set(value.split(',').map((tag) => tag.trim()).filter(Boolean))]
}

/** Metadados novos: os três campos da tela sobre os demais já gravados; vazio remove a chave. */
export function mergeMetadata(
  current: Record<string, string>,
  fields: Record<MetadataKey, string>,
): Record<string, string> {
  const next = { ...current }
  for (const { key } of METADATA_FIELDS) {
    const value = fields[key].trim()
    if (value) next[key] = value
    else delete next[key]
  }
  return next
}
