// Navegação principal numa lista única. As áreas de outras specs já estão previstas e desligadas:
// para ligá-las, a spec dona muda `enabled` e registra a rota em routes.tsx.
export type NavGroup = 'Gravações' | 'Organizar' | 'Conta'

export interface NavItem {
  to: string
  label: string
  group: NavGroup
  enabled: boolean
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Biblioteca', group: 'Gravações', enabled: true },
  { to: '/importar', label: 'Importar arquivo', group: 'Gravações', enabled: true },
  { to: '/pessoas', label: 'Pessoas', group: 'Organizar', enabled: true },
  { to: '/busca', label: 'Busca', group: 'Organizar', enabled: true },
  { to: '/colecoes', label: 'Coleções', group: 'Organizar', enabled: true },
  { to: '/tokens', label: 'Tokens de acesso', group: 'Conta', enabled: true },
  { to: '/app-desktop', label: 'App desktop', group: 'Conta', enabled: true },
]

/**
 * Itens ligados, agrupados na ordem da lista; grupos vazios somem. O painel admin não entra: ele
 * tem conta e login próprios (/admin/entrar).
 */
export function navGroups(items: readonly NavItem[] = NAV_ITEMS) {
  const groups = new Map<NavGroup, NavItem[]>()
  for (const item of items) {
    if (!item.enabled) continue
    groups.set(item.group, [...(groups.get(item.group) ?? []), item])
  }
  return [...groups].map(([group, entries]) => ({ group, items: entries }))
}
