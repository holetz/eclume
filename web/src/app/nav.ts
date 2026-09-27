// Navegação do shell em duas seções: a principal e a recolhível "Configurações e ajuda". As áreas
// de outras specs já estão previstas e desligadas: para ligá-las, a spec dona muda `enabled` e
// registra a rota em routes.tsx. As rotas seguem o mapa de telas v6. O painel admin não entra: ele tem
// conta e login próprios (/admin/entrar).
export type NavGroup = 'Gravações' | 'Organizar' | 'Minhas configurações' | 'Ajuda'
export type NavSection = 'main' | 'more'

export interface NavItem {
  to: string
  label: string
  group: NavGroup
  section: NavSection
  enabled: boolean
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Biblioteca', group: 'Gravações', section: 'main', enabled: true },
  { to: '/busca', label: 'Busca', group: 'Gravações', section: 'main', enabled: true },
  // Até holetz/eclume#37 levar o import para o modal da biblioteca.
  { to: '/importar', label: 'Importar arquivo', group: 'Gravações', section: 'main', enabled: true },
  { to: '/pessoas', label: 'Pessoas', group: 'Organizar', section: 'main', enabled: true },
  // Coleção convive com tag (mapa v6): agrupa as gravações que o usuário escolhe.
  { to: '/colecoes', label: 'Coleções', group: 'Organizar', section: 'main', enabled: true },
  { to: '/config/campos', label: 'Campos e regras', group: 'Organizar', section: 'main', enabled: true },
  { to: '/config/agendas', label: 'Tipos de agenda', group: 'Organizar', section: 'main', enabled: true },
  { to: '/config/mcp', label: 'Conexão MCP', group: 'Minhas configurações', section: 'more', enabled: true },
  { to: '/tokens', label: 'Tokens de acesso', group: 'Minhas configurações', section: 'more', enabled: true },
  { to: '/app-desktop', label: 'App desktop', group: 'Minhas configurações', section: 'more', enabled: true },
  { to: '/app-movel', label: 'App móvel', group: 'Minhas configurações', section: 'more', enabled: false },
  { to: '/ajuda', label: 'Central de ajuda', group: 'Ajuda', section: 'more', enabled: true },
]

export interface NavGroupEntry {
  group: NavGroup
  items: NavItem[]
}

/** Itens ligados, agrupados na ordem da lista e separados por seção; grupos vazios somem. */
export function navGroups(items: readonly NavItem[] = NAV_ITEMS): Record<NavSection, NavGroupEntry[]> {
  const sections: Record<NavSection, Map<NavGroup, NavItem[]>> = { main: new Map(), more: new Map() }
  for (const item of items) {
    if (!item.enabled) continue
    const groups = sections[item.section]
    groups.set(item.group, [...(groups.get(item.group) ?? []), item])
  }
  const entries = (groups: Map<NavGroup, NavItem[]>) =>
    [...groups].map(([group, list]) => ({ group, items: list }))
  return { main: entries(sections.main), more: entries(sections.more) }
}

/** Se a rota atual pertence a um item da seção recolhível. */
export function isInMoreSection(pathname: string, items: readonly NavItem[] = NAV_ITEMS): boolean {
  return items.some(
    (item) =>
      item.section === 'more' && item.enabled && (pathname === item.to || pathname.startsWith(`${item.to}/`)),
  )
}
