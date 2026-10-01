// Navegação do shell em duas seções: a principal, na barra lateral, e a do cabeçalho, nos menus da
// engrenagem (Minhas configurações) e da ajuda. Todas as áreas estão ligadas: para acrescentar uma,
// a spec dona registra o item aqui e a rota em routes.tsx, e `enabled: false` a mantém fora do menu
// até ficar pronta. As rotas seguem o mapa de telas v6. O painel admin não entra: ele tem conta e
// login próprios (/admin/entrar). Um item pode ser o destacado (`featured`): a barra lateral o desenha
// antes dos grupos, como ação primária com ícone. A barra lateral separa os dados da conta (Organizar)
// das regras que agem sozinhas depois de cada gravação (Regras); a engrenagem agrupa os itens por
// natureza (`part`), com um rótulo por parte.
import { MessageSquareText, type LucideIcon } from 'lucide-react'

type NavGroup = 'Gravações' | 'Organizar' | 'Regras' | 'Minhas configurações' | 'Ajuda'
/** As partes da engrenagem, na ordem em que aparecem. */
export type NavPart = 'Conta e privacidade' | 'Aparelhos' | 'Integrações' | 'Ambiente'
type NavSection = 'main' | 'header'

interface NavEntry {
  to: string
  label: string
  section: NavSection
  enabled: boolean
  /** Prefixos de rota que também acendem o item (a gravação pertence à Biblioteca). */
  matches?: string[]
  /** A parte da engrenagem em que o item mora (só na seção `header`). */
  part?: NavPart
}

interface GroupedItem extends NavEntry {
  group: NavGroup
  featured?: never
}

/**
 * O item destacado da barra lateral: a ação primária, acima dos grupos, sem grupo nem título. Com a
 * conta sem gravação, o shell o desenha como secundário, sem tirá-lo do lugar.
 */
export interface FeaturedItem extends NavEntry {
  featured: true
  icon: LucideIcon
  group?: never
}

type NavItem = GroupedItem | FeaturedItem

export const NAV_ITEMS: readonly NavItem[] = [
  // Perguntar é o primeiro da barra lateral, acima dos grupos; a rota segue sendo /perguntas.
  { to: '/perguntas', label: 'Perguntar', section: 'main', enabled: true, featured: true, icon: MessageSquareText },
  { to: '/', label: 'Biblioteca', group: 'Gravações', section: 'main', enabled: true, matches: ['/gravacoes/'] },
  { to: '/busca', label: 'Busca', group: 'Gravações', section: 'main', enabled: true },
  { to: '/pessoas', label: 'Pessoas', group: 'Organizar', section: 'main', enabled: true },
  // A coleção convive com a tag e fica em Organizar (holetz/eclume#38).
  { to: '/colecoes', label: 'Coleções', group: 'Organizar', section: 'main', enabled: true },
  // O cadastro de tags fica ao lado das coleções (holetz/eclume#78).
  { to: '/tags', label: 'Tags', group: 'Organizar', section: 'main', enabled: true },
  // Regras: o que o eclume faz sozinho depois de cada gravação, com a visão geral à frente (holetz/eclume#120).
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

/** O item destacado, quando ligado: a barra lateral o desenha antes dos grupos. */
export function featuredItem(items: readonly NavItem[] = NAV_ITEMS): FeaturedItem | undefined {
  return items.find((item): item is FeaturedItem => item.enabled && item.featured === true)
}

/**
 * Itens ligados, agrupados na ordem da lista e separados por seção; grupos vazios somem. O destacado
 * fica de fora: ele não pertence a grupo.
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

/** Se o item está aceso na rota: a própria rota (a raiz só nela mesma), as filhas e os `matches`. */
export function isItemActive(item: NavItem, pathname: string): boolean {
  if (item.matches?.some((prefix) => pathname.startsWith(prefix))) return true
  if (item.to === '/') return pathname === '/'
  return pathname === item.to || pathname.startsWith(`${item.to}/`)
}
