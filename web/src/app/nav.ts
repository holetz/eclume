// Shell navigation in two sections: the main one, in the sidebar, and the header one, in the gear
// menu ("Minhas configurações") and the help menu. Every area is enabled: to add one, the owning spec
// registers the item here and the route in routes.tsx, and `enabled: false` keeps it out of the menu
// until it is ready. The routes follow the v6 screen map. The admin panel is not here: it has its own
// account and login (/admin/entrar). One item can be the featured one (`featured`): the sidebar draws it
// before the groups, as a primary action with an icon. The sidebar separates the account's data
// ("Organizar") from the rules that act on their own after each recording ("Regras"); the gear menu groups
// the items by nature (`part`), with one label per part. The "Agente" group gathers what belongs to the
// Agent beyond the conversation ("Conversas" and "Habilidades"), right below the featured item.
// Groups, parts and items are ids; their text is in the `shell` catalog (`nav.group`, `nav.part`,
// `nav.item`), read through `groupLabel`, `partLabel` and `itemLabel`.
import { MessageSquareText, type LucideIcon } from 'lucide-react'
import { i18n } from '../i18n'
import type shell from '../i18n/en/shell'

type NavGroup = keyof typeof shell.nav.group
/** The parts of the gear menu, in the order they appear. */
export type NavPart = keyof typeof shell.nav.part
type NavItemId = keyof typeof shell.nav.item
type NavSection = 'main' | 'header'

interface NavEntry {
  id: NavItemId
  to: string
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
    id: 'agent',
    to: '/agente',
    section: 'main',
    enabled: true,
    featured: true,
    icon: MessageSquareText,
    excludes: ['/agente/conversas', '/agente/habilidades'],
  },
  { id: 'conversations', to: '/agente/conversas', group: 'agent', section: 'main', enabled: true },
  { id: 'skills', to: '/agente/habilidades', group: 'agent', section: 'main', enabled: true },
  { id: 'library', to: '/', group: 'recordings', section: 'main', enabled: true, matches: ['/gravacoes/'] },
  { id: 'search', to: '/busca', group: 'recordings', section: 'main', enabled: true },
  { id: 'people', to: '/pessoas', group: 'organize', section: 'main', enabled: true },
  // The collection coexists with the tag and sits in "Organizar" (holetz/eclume#38).
  { id: 'collections', to: '/colecoes', group: 'organize', section: 'main', enabled: true },
  // The tag registry sits next to the collections (holetz/eclume#78).
  { id: 'tags', to: '/tags', group: 'organize', section: 'main', enabled: true },
  // Rules: what eclume does on its own after each recording, with the overview first (holetz/eclume#120).
  { id: 'automation', to: '/config/automacao', group: 'rules', section: 'main', enabled: true },
  { id: 'agendaTypes', to: '/config/agendas', group: 'rules', section: 'main', enabled: true },
  { id: 'fields', to: '/config/campos', group: 'rules', section: 'main', enabled: true },
  { id: 'account', to: '/config/conta', group: 'settings', part: 'account', section: 'header', enabled: true },
  { id: 'desktopApp', to: '/app-desktop', group: 'settings', part: 'devices', section: 'header', enabled: true },
  { id: 'mobileApp', to: '/app-movel', group: 'settings', part: 'devices', section: 'header', enabled: true },
  { id: 'mcp', to: '/config/mcp', group: 'settings', part: 'integrations', section: 'header', enabled: true },
  { id: 'tokens', to: '/tokens', group: 'settings', part: 'integrations', section: 'header', enabled: true },
  { id: 'environment', to: '/config/ambiente', group: 'settings', part: 'environment', section: 'header', enabled: true },
  { id: 'helpCenter', to: '/ajuda', group: 'help', section: 'header', enabled: true },
]

export const itemLabel = (item: Pick<NavEntry, 'id'>): string => i18n.t(`shell:nav.item.${item.id}`)
export const groupLabel = (group: NavGroup): string => i18n.t(`shell:nav.group.${group}`)
export const partLabel = (part: NavPart): string => i18n.t(`shell:nav.part.${part}`)

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
