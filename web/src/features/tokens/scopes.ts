import type { Schemas } from '../../api/client'
import { i18n } from '../../i18n'
import type tokens from '../../i18n/en/tokens'

export type Scope = Schemas['Scope']
export type DevicePlatform = Schemas['DevicePlatform']

/** The key of every token list: invalidating it refreshes Access tokens and the devices. */
export const TOKENS_KEY = ['tokens'] as const

type GroupId = keyof typeof tokens.group
type ScopeGroup = { id: GroupId; readonly label: string; readonly short: string; scopes: readonly Scope[] }

/** A group whose `label` and `short` read the `tokens` catalog in the active locale. */
const group = (id: GroupId, scopes: readonly Scope[]): ScopeGroup => ({
  id,
  scopes,
  get label() {
    return i18n.t(`tokens:group.${id}.label`)
  },
  get short() {
    return i18n.t(`tokens:group.${id}.short`)
  },
})

/** The scope groups of holetz/eclume#35: the main choice in Access tokens and in MCP connection. */
export const SCOPE_GROUPS: readonly ScopeGroup[] = [
  group('ler', ['recordings:read', 'transcripts:read']),
  group('resumos', ['summaries:read', 'summaries:write']),
  group('campos', ['recordings:write']),
  group('excluir', ['recordings:delete']),
]

const scope = (id: Scope) => {
  const key = id.replace(':', '_') as keyof typeof tokens.scope
  return {
    scope: id,
    get label(): string {
      return i18n.t(`tokens:scope.${key}.label`)
    },
    get description(): string {
      return i18n.t(`tokens:scope.${key}.description`)
    },
  }
}

export const SCOPES: readonly { scope: Scope; readonly label: string; readonly description: string }[] = [
  scope('recordings:read'),
  scope('recordings:write'),
  scope('recordings:delete'),
  scope('transcripts:read'),
  scope('transcripts:write'),
  scope('people:read'),
  scope('people:write'),
  scope('summaries:read'),
  scope('summaries:write'),
]

/** Ready-made combinations for the known clients, in "Individual scopes". */
export const PRESETS: readonly { readonly name: string; label: string; scopes: Scope[] }[] = [
  {
    get name() {
      return i18n.t('tokens:preset.lumea')
    },
    // i18n-ignore: the product name
    label: 'lumea',
    scopes: ['transcripts:read', 'people:read'],
  },
]

export function hasGroup(scopes: readonly Scope[], group: (typeof SCOPE_GROUPS)[number]): boolean {
  return group.scopes.every((scope) => scopes.includes(scope))
}

/**
 * The table's short summary ("read, summaries, fields"): one name per complete group and "+N" for the
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

const expiration = (value: keyof typeof tokens.expiration, days: number | null) => ({
  value,
  days,
  get label(): string {
    return i18n.t(`tokens:expiration.${value}`)
  },
})

export const EXPIRATIONS: readonly { value: string; readonly label: string; days: number | null }[] = [
  expiration('30', 30),
  expiration('90', 90),
  expiration('never', null),
]

export function expiresAt(days: number | null, now: Date = new Date()): string | null {
  if (days === null) return null
  return new Date(now.getTime() + days * 86_400_000).toISOString()
}
