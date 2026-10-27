// Shell navigation in two sections: the main one, in the sidebar, and the header one, in the gear
// menu ("Minhas configurações") and the help menu. Every area is enabled: to add one, the owning spec
// registers the item here and the route in routes.tsx, and `enabled: false` keeps it out of the menu
// until it is ready. The routes follow the v6 screen map. The admin panel is not here: it has its own
// account and login (/admin/entrar). One item can be the featured one (`featured`): the sidebar draws it
// before the groups, as a primary action with an icon. The sidebar separates the account's data
// ("Organizar") from the rules that act on their own after each recording ("Regras"); the gear menu groups
// the items by nature (`part`), with one label per part. The "Agente" group gathers what belongs to the
// Agent beyond the conversation ("Conversas" and "Habilidades"), right below the featured item.
import { MessageSquareText, type LucideIcon } from 'lucide-react'

type NavGroup = 'Agente' | 'Gravações' | 'Organizar' | 'Regras' | 'Minhas configurações' | 'Ajuda'
/** The parts of the gear menu, in the order they appear. */
export type NavPart = 'Conta e privacidade' | 'Aparelhos' | 'Integrações' | 'Ambiente'
type NavSection = 'main' | 'header'

interface NavEntry {
  to: string
  label: string
  section: NavSection
  enabled: boolean
  /** Route prefixes that also light the item (a recording belongs to the Library). */
  matches?: string[]
  /** Prefixes under the item's route that belong to another item and do not light it (Conversations, under Agent). */
  excludes?: string[]
  /** The part of the gear menu the item lives in (only in the `header` section). */
  part?: NavPart
}

interface GroupedItem extends NavEntry {
  group: NavGroup
  featured?: never
}

/**
 * The sidebar's featured item: the primary action, above the groups, with neither group nor title. With
 * the account having no recording, the shell draws it as secondary, without moving it.
 */
export interface FeaturedItem extends NavEntry {
  featured: true
  icon: LucideIcon
  group?: never
}

type NavItem = GroupedItem | FeaturedItem

export const NAV_ITEMS: readonly NavItem[] = [
  // The Agent comes first in the sidebar, above the groups; /perguntas, the old name, redirects
  // (holetz/eclume#142). The pages of the Agent group live under /agente/ and do not light the featured item.
  {
    to: '/agente',
    label: 'Agente',
    section: 'main',
    enabled: true,
    featured: true,
    icon: MessageSquareText,
    excludes: ['/agente/conversas', '/agente/habilidades'],
  },
  { to: '/agente/conversas', label: 'Conversas', group: 'Agente', section: 'main', enabled: true },
  { to: '/agente/habilidades', label: 'Habilidades', group: 'Agente', section: 'main', enabled: true },
  { to: '/', label: 'Biblioteca', group: 'Gravações', section: 'main', enabled: true, matches: ['/gravacoes/'] },
  { to: '/busca', label: 'Busca', group: 'Gravações', section: 'main', enabled: true },
  { to: '/pessoas', label: 'Pessoas', group: 'Organizar', section: 'main', enabled: true },
  // The collection coexists with the tag and sits in "Organizar" (holetz/eclume#38).
  { to: '/colecoes', label: 'Coleções', group: 'Organizar', section: 'main', enabled: true },
  // The tag registry sits next to the collections (holetz/eclume#78).
  { to: '/tags', label: 'Tags', group: 'Organizar', section: 'main', enabled: true },
  // Rules: what eclume does on its own after each recording, with the overview first (holetz/eclume#120).
  { to: '/config/automacao', label: 'Processamento automático', group: 'Regras', section: 'main', enabled: true },
  { to: '/config/agendas', label: 'Tipos de agenda', group: 'Regras', section: 'main', enabled: true },
  { to: '/config/campos', label: 'Campos personalizados', group: 'Regras', section: 'main', enabled: true },
  { to: '/config/conta', label: 'Conta', group: 'Minhas configurações', part: 'Conta e privacidade', section: 'header', enabled: true },
  { to: '/app-desktop', label: 'App desktop', group: 'Minhas configurações', part: 'Aparelhos', section: 'header', enabled: true },
  { to: '/app-movel', label: 'App móvel', group: 'Minhas configurações', part: 'Aparelhos', section: 'header', enabled: true },
  { to: '/config/mcp', label: 'Conexão MCP', group: 'Minhas configurações', part: 'Integrações', section: 'header', enabled: true },
  { to: '/tokens', label: 'Tokens de acesso', group: 'Minhas configurações', part: 'Integrações', section: 'header', enabled: true },
  { to: '/config/ambiente', label: 'Ambiente', group: 'Minhas configurações', part: 'Ambiente', section: 'header', enabled: true },
  { to: '/ajuda', label: 'Central de ajuda', group: 'Ajuda', section: 'header', enabled: true },
]

export interface NavGroupEntry {
  group: NavGroup
  items: GroupedItem[]
}

/** The featured item, when enabled: the sidebar draws it before the groups. */
export function featuredItem(items: readonly NavItem[] = NAV_ITEMS): FeaturedItem | undefined {
  return items.find((item): item is FeaturedItem => item.enabled && item.featured === true)
}

/**
 * Enabled items, grouped in list order and split by section; empty groups disappear. The featured item
 * stays out: it belongs to no group.
 */
export function navGroups(items: readonly NavItem[] = NAV_ITEMS): Record<NavSection, NavGroupEntry[]> {
  const sections: Record<NavSection, Map<NavGroup, GroupedItem[]>> = { main: new Map(), header: new Map() }
  for (const item of items) {
    if (!item.enabled || item.featured) continue
    const groups = sections[item.section]
    groups.set(item.group, [...(groups.get(item.group) ?? []), item])
  }
  const entries = (groups: Map<NavGroup, GroupedItem[]>) =>
    [...groups].map(([group, list]) => ({ group, items: list }))
  return { main: entries(sections.main), header: entries(sections.header) }
}

/**
 * Whether the item is lit on the route: its own route (the root only on itself), its children and the
 * `matches`, minus the `excludes`.
 */
export function isItemActive(item: NavItem, pathname: string): boolean {
  if (item.excludes?.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return false
  if (item.matches?.some((prefix) => pathname.startsWith(prefix))) return true
  if (item.to === '/') return pathname === '/'
  return pathname === item.to || pathname.startsWith(`${item.to}/`)
}
