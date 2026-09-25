// Navegação principal numa lista única. As áreas de outras specs já estão previstas e desligadas:
// para ligá-las, a spec dona muda `enabled` e registra a rota em routes.tsx.
export type NavGroup = 'Gravações' | 'Organizar' | 'Conta' | 'Administração'

export interface NavItem {
  to: string
  label: string
  group: NavGroup
  enabled: boolean
  adminOnly?: boolean
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Biblioteca', group: 'Gravações', enabled: true },
  { to: '/importar', label: 'Importar arquivo', group: 'Gravações', enabled: true },
  { to: '/pessoas', label: 'Pessoas', group: 'Organizar', enabled: true },
  { to: '/busca', label: 'Busca', group: 'Organizar', enabled: false }, // holetz/eclume#11
  { to: '/colecoes', label: 'Coleções', group: 'Organizar', enabled: false }, // holetz/eclume#11
  { to: '/tokens', label: 'Tokens de acesso', group: 'Conta', enabled: true },
  { to: '/app-desktop', label: 'App desktop', group: 'Conta', enabled: true },
  { to: '/admin', label: 'Painel admin', group: 'Administração', enabled: false, adminOnly: true }, // holetz/eclume#12
]

export type Role = 'admin' | 'member'

/** Itens visíveis para o papel, agrupados na ordem da lista; grupos vazios somem. */
export function navGroups(role: Role, items: readonly NavItem[] = NAV_ITEMS) {
  const groups = new Map<NavGroup, NavItem[]>()
  for (const item of items) {
    if (!item.enabled || (item.adminOnly && role !== 'admin')) continue
    groups.set(item.group, [...(groups.get(item.group) ?? []), item])
  }
  return [...groups].map(([group, entries]) => ({ group, items: entries }))
}
