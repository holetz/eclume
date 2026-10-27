import type { Schemas } from '../../api/client'

export type Scope = Schemas['Scope']
export type DevicePlatform = Schemas['DevicePlatform']

/** The key of every token list: invalidating it refreshes Tokens de acesso and the devices. */
export const TOKENS_KEY = ['tokens'] as const

/** The scope groups of holetz/eclume#35: the main choice in Tokens de acesso and in Conexão MCP. */
export const SCOPE_GROUPS: readonly { id: string; label: string; short: string; scopes: readonly Scope[] }[] = [
  { id: 'ler', label: 'Buscar e ler gravações', short: 'ler', scopes: ['recordings:read', 'transcripts:read'] },
  { id: 'resumos', label: 'Ler e editar resumos', short: 'resumos', scopes: ['summaries:read', 'summaries:write'] },
  { id: 'campos', label: 'Editar campos e tags', short: 'campos', scopes: ['recordings:write'] },
  { id: 'excluir', label: 'Excluir gravações', short: 'excluir', scopes: ['recordings:delete'] },
]

export const SCOPES: readonly { scope: Scope; label: string; description: string }[] = [
  { scope: 'recordings:read', label: 'Ler gravações', description: 'Listar e buscar gravações, ver o estado e ouvir o áudio.' },
  { scope: 'recordings:write', label: 'Enviar e editar gravações', description: 'Subir áudio e editar título, campos e tags.' },
  { scope: 'recordings:delete', label: 'Excluir gravações', description: 'Excluir gravações, o áudio e a transcrição.' },
  { scope: 'transcripts:read', label: 'Ler transcrições', description: 'Ler e exportar transcrições.' },
  { scope: 'transcripts:write', label: 'Editar transcrições', description: 'Renomear locutores e corrigir falas.' },
  { scope: 'people:read', label: 'Ler pessoas', description: 'Consultar as suas pessoas.' },
  { scope: 'people:write', label: 'Editar pessoas', description: 'Cadastrar e alterar pessoas.' },
  { scope: 'summaries:read', label: 'Ler resumos', description: 'Ler resumos e as versões deles.' },
  { scope: 'summaries:write', label: 'Editar resumos', description: 'Gerar e editar resumos.' },
]

/** Ready-made combinations for the known clients, in "Escopos individuais". */
export const PRESETS: readonly { name: string; label: string; scopes: Scope[] }[] = [
  { name: 'lumea — importador', label: 'lumea', scopes: ['transcripts:read', 'people:read'] },
]

export function hasGroup(scopes: readonly Scope[], group: (typeof SCOPE_GROUPS)[number]): boolean {
  return group.scopes.every((scope) => scopes.includes(scope))
}

/**
 * The table's short summary ("ler, resumos, campos"): one name per complete group and "+N" for the
 * loose scopes. With no complete group, it lists the scopes as they came.
 */
export function summarizeScopes(scopes: readonly Scope[]): string {
  const groups = SCOPE_GROUPS.filter((group) => hasGroup(scopes, group))
  if (groups.length === 0) return scopes.join(', ')
  const covered = new Set(groups.flatMap((group) => group.scopes))
  const loose = scopes.filter((scope) => !covered.has(scope)).length
  return [...groups.map((group) => group.short), ...(loose > 0 ? [`+${loose}`] : [])].join(', ')
}

export const PLATFORM_LABELS: Record<DevicePlatform, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  ios: 'iPhone',
  android: 'Android',
}

export const EXPIRATIONS: readonly { value: string; label: string; days: number | null }[] = [
  { value: '30', label: '30 dias', days: 30 },
  { value: '90', label: '90 dias', days: 90 },
  { value: 'never', label: 'Nunca', days: null },
]

export function expiresAt(days: number | null, now: Date = new Date()): string | null {
  if (days === null) return null
  return new Date(now.getTime() + days * 86_400_000).toISOString()
}
