// Navegação do shell em duas seções: a principal, na barra lateral, e a do cabeçalho, nos menus da
// engrenagem (Minhas configurações) e da ajuda. Todas as áreas estão ligadas: para acrescentar uma,
// a spec dona registra o item aqui e a rota em routes.tsx, e `enabled: false` a mantém fora do menu
// até ficar pronta. As rotas seguem o mapa de telas v6. O painel admin não entra: ele tem conta e
// login próprios (/admin/entrar).
type NavGroup = 'Gravações' | 'Organizar' | 'Minhas configurações' | 'Ajuda'
type NavSection = 'main' | 'header'

interface NavItem {
  to: string
  label: string
  group: NavGroup
  section: NavSection
  enabled: boolean
  /** Prefixos de rota que também acendem o item (a gravação pertence à Biblioteca). */
  matches?: string[]
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Biblioteca', group: 'Gravações', section: 'main', enabled: true, matches: ['/gravacoes/'] },
  { to: '/busca', label: 'Busca', group: 'Gravações', section: 'main', enabled: true },
  { to: '/perguntas', label: 'Perguntas', group: 'Gravações', section: 'main', enabled: true },
  { to: '/pessoas', label: 'Pessoas', group: 'Organizar', section: 'main', enabled: true },
  // A coleção convive com a tag e fica em Organizar (holetz/eclume#38).
  { to: '/colecoes', label: 'Coleções', group: 'Organizar', section: 'main', enabled: true },
  { to: '/config/campos', label: 'Campos e regras', group: 'Organizar', section: 'main', enabled: true },
  { to: '/config/agendas', label: 'Tipos de agenda', group: 'Organizar', section: 'main', enabled: true },
  { to: '/config/ambiente', label: 'Ambiente', group: 'Minhas configurações', section: 'header', enabled: true },
  { to: '/config/mcp', label: 'Conexão MCP', group: 'Minhas configurações', section: 'header', enabled: true },
  { to: '/tokens', label: 'Tokens de acesso', group: 'Minhas configurações', section: 'header', enabled: true },
  { to: '/app-desktop', label: 'App desktop', group: 'Minhas configurações', section: 'header', enabled: true },
  { to: '/app-movel', label: 'App móvel', group: 'Minhas configurações', section: 'header', enabled: true },
  { to: '/ajuda', label: 'Central de ajuda', group: 'Ajuda', section: 'header', enabled: true },
]

export interface NavGroupEntry {
  group: NavGroup
  items: NavItem[]
}

/** Itens ligados, agrupados na ordem da lista e separados por seção; grupos vazios somem. */
export function navGroups(items: readonly NavItem[] = NAV_ITEMS): Record<NavSection, NavGroupEntry[]> {
  const sections: Record<NavSection, Map<NavGroup, NavItem[]>> = { main: new Map(), header: new Map() }
  for (const item of items) {
    if (!item.enabled) continue
    const groups = sections[item.section]
    groups.set(item.group, [...(groups.get(item.group) ?? []), item])
  }
  const entries = (groups: Map<NavGroup, NavItem[]>) =>
    [...groups].map(([group, list]) => ({ group, items: list }))
  return { main: entries(sections.main), header: entries(sections.header) }
}

/** Se o item está aceso na rota: a própria rota (a raiz só nela mesma), as filhas e os `matches`. */
export function isItemActive(item: NavItem, pathname: string): boolean {
  if (item.matches?.some((prefix) => pathname.startsWith(prefix))) return true
  if (item.to === '/') return pathname === '/'
  return pathname === item.to || pathname.startsWith(`${item.to}/`)
}
