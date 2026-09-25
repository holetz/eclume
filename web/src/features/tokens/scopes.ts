import type { Schemas } from '../../api/client'

export type Scope = Schemas['Scope']

export const SCOPES: readonly { scope: Scope; label: string; description: string }[] = [
  { scope: 'recordings:read', label: 'Ler gravações', description: 'Listar gravações, ver o estado e ouvir o áudio.' },
  { scope: 'recordings:write', label: 'Enviar gravações', description: 'Subir áudio, editar e excluir gravações.' },
  { scope: 'transcripts:read', label: 'Ler transcrições', description: 'Ler e exportar transcrições.' },
  { scope: 'transcripts:write', label: 'Editar transcrições', description: 'Renomear locutores e corrigir falas.' },
  { scope: 'people:read', label: 'Ler pessoas', description: 'Consultar o diretório de pessoas.' },
  { scope: 'people:write', label: 'Editar pessoas', description: 'Cadastrar e alterar pessoas.' },
  { scope: 'summaries:read', label: 'Ler resumos', description: 'Ler resumos e templates.' },
  { scope: 'summaries:write', label: 'Gerar resumos', description: 'Gerar resumos e editar templates.' },
]

/** Combinações prontas para os clientes conhecidos. */
export const PRESETS: readonly { name: string; label: string; scopes: Scope[] }[] = [
  { name: 'App desktop', label: 'App desktop', scopes: ['recordings:read', 'recordings:write'] },
  { name: 'lumea — importador', label: 'lumea', scopes: ['transcripts:read', 'people:read'] },
]

export function scopeLabel(scope: string): string {
  return SCOPES.find((s) => s.scope === scope)?.label ?? scope
}

export const EXPIRATIONS: readonly { value: string; label: string; days: number | null }[] = [
  { value: 'never', label: 'Não expira', days: null },
  { value: '30', label: '30 dias', days: 30 },
  { value: '90', label: '90 dias', days: 90 },
  { value: '365', label: '1 ano', days: 365 },
]

export function expiresAt(days: number | null, now: Date = new Date()): string | null {
  if (days === null) return null
  return new Date(now.getTime() + days * 86_400_000).toISOString()
}
